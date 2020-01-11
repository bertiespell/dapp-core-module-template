import { app } from "@arkecosystem/core-container";
import { Database, Logger, Shared, State } from "@arkecosystem/core-interfaces";
import { IDatabaseService } from "@arkecosystem/core-interfaces/dist/core-database";
import { Wallets } from "@arkecosystem/core-state";
import { roundCalculator } from "@arkecosystem/core-utils";
import { Crypto, Enums, Identities, Interfaces, Utils } from "@arkecosystem/crypto";
import cloneDeep from "lodash.clonedeep";
import pluralize from "pluralize";

export class DappManager {
    public forgingDelegates: State.IWallet[] = undefined;

    private readonly logger: Logger.ILogger = app.resolvePlugin<Logger.ILogger>(
        "logger"
    );

    private databaseService: IDatabaseService = undefined;
    private walletManager: State.IWalletManager = undefined;

    /**
     * Your dApp init code goes here
     * @param options - from default.ts
     * TODO: create type for options
     */
    public start(options: any) {
        this.logger.info("Initialization of dApp");
        if (options.database_service) {
            this.databaseService = options.database_service;
            this.walletManager = options.database_service.walletManager; // TODO: handle errors?
        } else {
            // error handling
        }
    }

    /**
     * Your dApp stopping code goes here
     */
    public stop() {
        this.logger.info("Stopping dApp");
    }

    public async getActiveDelegates(
        roundInfo?: Shared.IRoundInfo,
        delegates?: State.IWallet[],
    ): Promise<State.IWallet[]> {
 
        if (!roundInfo) {
            const database: Database.IDatabaseService = app.resolvePlugin("database");
            const lastBlock = await database.getLastBlock();
            roundInfo = roundCalculator.calculateRound(lastBlock.data.height);
        }

        const { round } = roundInfo;

        if (
            this.forgingDelegates &&
            this.forgingDelegates.length &&
            this.forgingDelegates[0].getAttribute<number>("delegate.round") === round
        ) {
            return this.forgingDelegates;
        }

        // When called during applyRound we already know the delegates, so we don't have to query the database.
        if (!delegates || delegates.length === 0) {
            delegates = (await this.databaseService.connection.roundsRepository.findById(round)).map(({ publicKey, balance }) =>
                Object.assign(new Wallets.Wallet(Identities.Address.fromPublicKey(publicKey)), {
                    publicKey,
                    attributes: {
                        delegate: {
                            voteBalance: Utils.BigNumber.make(balance),
                            username: this.walletManager.findByPublicKey(publicKey).getAttribute("delegate.username"),
                        },
                    },
                }),
            );
        }

        for (const delegate of delegates) {
            delegate.setAttribute("delegate.round", round);
        }

        const seedSource: string = round.toString();
        let currentSeed: Buffer = Crypto.HashAlgorithms.sha256(seedSource);

        delegates = cloneDeep(delegates);
        for (let i = 0, delCount = delegates.length; i < delCount; i++) {
            for (let x = 0; x < 4 && i < delCount; i++ , x++) {
                const newIndex = currentSeed[x] % delCount;
                const b = delegates[newIndex];
                delegates[newIndex] = delegates[i];
                delegates[i] = b;
            }
            currentSeed = Crypto.HashAlgorithms.sha256(currentSeed);
        }

        return delegates;
    }

    /**
     * Updates the vote balances of the respective delegates of sender and recipient.
     * If the transaction is not a vote...
     *    1. fee + amount is removed from the sender's delegate vote balance
     *    2. amount is added to the recipient's delegate vote balance
     *
     * in case of a vote...
     *    1. the full sender balance is added to the sender's delegate vote balance
     *
     * If revert is set to true, the operations are reversed (plus -> minus, minus -> plus).
     * @param sender 
     * @param recipient 
     * @param transaction 
     * @param lockWallet 
     * @param lockTransaction 
     * @param revert 
     */
    public updateVoteBalances(
        sender: State.IWallet,
        recipient: State.IWallet,
        transaction: Interfaces.ITransactionData,
        lockWallet: State.IWallet,
        lockTransaction: Interfaces.ITransactionData,
        revert: boolean = false,
    ): void {
        if (
            transaction.type === Enums.TransactionType.Vote &&
            transaction.typeGroup === Enums.TransactionTypeGroup.Core
        ) {

            const vote: string = transaction.asset.votes[0];
            const delegate: State.IWallet = this.walletManager.findByPublicKey(vote.substr(1));
            let voteBalance: Utils.BigNumber = delegate.getAttribute("delegate.voteBalance", Utils.BigNumber.ZERO);

            if (vote.startsWith("+")) {
                voteBalance = revert
                    ? voteBalance.minus(sender.balance.minus(transaction.fee))
                    : voteBalance.plus(sender.balance);
            } else {
                voteBalance = revert
                    ? voteBalance.plus(sender.balance)
                    : voteBalance.minus(sender.balance.plus(transaction.fee));
            }

            delegate.setAttribute("delegate.voteBalance", voteBalance);
        } else {
            // Update vote balance of the sender's delegate
            if (sender.hasVoted()) {
                const delegate: State.IWallet = this.walletManager.findByPublicKey(sender.getAttribute("vote"));
                const amount =
                    transaction.type === Enums.TransactionType.MultiPayment &&
                    transaction.typeGroup === Enums.TransactionTypeGroup.Core
                        ? transaction.asset.payments.reduce(
                              (prev, curr) => prev.plus(curr.amount),
                              Utils.BigNumber.ZERO,
                          )
                        : transaction.amount;
                const total: Utils.BigNumber = amount.plus(transaction.fee);

                const voteBalance: Utils.BigNumber = delegate.getAttribute(
                    "delegate.voteBalance",
                    Utils.BigNumber.ZERO,
                );
                let newVoteBalance: Utils.BigNumber;

                if (
                    transaction.type === Enums.TransactionType.HtlcLock &&
                    transaction.typeGroup === Enums.TransactionTypeGroup.Core
                ) {
                    // HTLC Lock keeps the locked amount as the sender's delegate vote balance
                    newVoteBalance = revert ? voteBalance.plus(transaction.fee) : voteBalance.minus(transaction.fee);
                } else if (
                    transaction.type === Enums.TransactionType.HtlcClaim &&
                    transaction.typeGroup === Enums.TransactionTypeGroup.Core
                ) {
                    // HTLC Claim transfers the locked amount to the lock recipient's (= claim sender) delegate vote balance
                    newVoteBalance = revert
                        ? voteBalance.plus(transaction.fee).minus(lockTransaction.amount)
                        : voteBalance.minus(transaction.fee).plus(lockTransaction.amount);
                } else {
                    // General case : sender delegate vote balance reduced by amount + fees (or increased if revert)
                    newVoteBalance = revert ? voteBalance.plus(total) : voteBalance.minus(total);
                }
                delegate.setAttribute("delegate.voteBalance", newVoteBalance);
            }

            if (
                transaction.type === Enums.TransactionType.HtlcClaim &&
                transaction.typeGroup === Enums.TransactionTypeGroup.Core &&
                lockWallet.hasAttribute("vote")
            ) {
                // HTLC Claim transfers the locked amount to the lock recipient's (= claim sender) delegate vote balance
                const lockWalletDelegate: State.IWallet = this.walletManager.findByPublicKey(lockWallet.getAttribute("vote"));
                const lockWalletDelegateVoteBalance: Utils.BigNumber = lockWalletDelegate.getAttribute(
                    "delegate.voteBalance",
                    Utils.BigNumber.ZERO,
                );
                lockWalletDelegate.setAttribute(
                    "delegate.voteBalance",
                    revert
                        ? lockWalletDelegateVoteBalance.plus(lockTransaction.amount)
                        : lockWalletDelegateVoteBalance.minus(lockTransaction.amount),
                );
            }

            if (
                transaction.type === Enums.TransactionType.MultiPayment &&
                transaction.typeGroup === Enums.TransactionTypeGroup.Core
            ) {
                // go through all payments and update recipients delegates vote balance
                for (const { recipientId, amount } of transaction.asset.payments) {
                    const recipientWallet: State.IWallet = this.walletManager.findByAddress(recipientId);
                    const vote = recipientWallet.getAttribute("vote");
                    if (vote) {
                        const delegate: State.IWallet = this.walletManager.findByPublicKey(vote);
                        const voteBalance: Utils.BigNumber = delegate.getAttribute(
                            "delegate.voteBalance",
                            Utils.BigNumber.ZERO,
                        );
                        delegate.setAttribute(
                            "delegate.voteBalance",
                            revert ? voteBalance.minus(amount) : voteBalance.plus(amount),
                        );
                    }
                }
            }

            // Update vote balance of recipient's delegate
            if (
                recipient &&
                recipient.hasVoted() &&
                (transaction.type !== Enums.TransactionType.HtlcLock ||
                    transaction.typeGroup !== Enums.TransactionTypeGroup.Core)
            ) {
                const delegate: State.IWallet = this.walletManager.findByPublicKey(recipient.getAttribute("vote"));
                const voteBalance: Utils.BigNumber = delegate.getAttribute(
                    "delegate.voteBalance",
                    Utils.BigNumber.ZERO,
                );

                delegate.setAttribute(
                    "delegate.voteBalance",
                    revert ? voteBalance.minus(transaction.amount) : voteBalance.plus(transaction.amount),
                );
            }
        }
    }

    public buildVoteBalances(): void {
        for (const voter of this.walletManager.allByPublicKey()) {
            if (voter.hasVoted()) {
                const delegate: State.IWallet = this.walletManager.findByPublicKey(voter.getAttribute<string>("vote"));
                const voteBalance: Utils.BigNumber = delegate.getAttribute("delegate.voteBalance");
                const lockedBalance = voter.getAttribute("htlc.lockedBalance", Utils.BigNumber.ZERO);
                delegate.setAttribute("delegate.voteBalance", voteBalance.plus(voter.balance).plus(lockedBalance));
            }
        }
    }

    public async initializeActiveDelegates(height: number): Promise<void> {
        this.forgingDelegates = undefined;

        const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(height)

        await this.setForgingDelegatesOfRound(roundInfo, await this.calcPreviousActiveDelegates(roundInfo));
    }

    public async updateForgingDelegatesOfRound(roundInfo: Shared.IRoundInfo, blocks: Interfaces.IBlock[]): Promise<void> {
        this.setForgingDelegatesOfRound(roundInfo,
            await this.calcPreviousActiveDelegates(roundInfo, blocks))
    }

    public async updateDelegates(roundInfo?: Shared.IRoundInfo): Promise<State.IWallet[]> {
        const delegates = this.buildDelegateRanking(roundInfo);
        await this.setForgingDelegatesOfRound(roundInfo, delegates);
        return delegates;
    }

    // could be a private method based on deprecated/refactored methods elsewhere
    public buildDelegateRanking(roundInfo?: Shared.IRoundInfo): State.IWallet[] {
        
        const delegatesActive: State.IWallet[] = [];

        for (const delegate of this.walletManager.allByUsername()) {
            if (delegate.hasAttribute("delegate.resigned")) {
                delegate.forgetAttribute("delegate.rank");
            } else {
                delegatesActive.push(delegate);
            }
        }

        let delegatesSorted = delegatesActive
            .sort((a, b) => {
                const voteBalanceA: Utils.BigNumber = a.getAttribute("delegate.voteBalance");
                const voteBalanceB: Utils.BigNumber = b.getAttribute("delegate.voteBalance");

                const diff = voteBalanceB.comparedTo(voteBalanceA);
                if (diff === 0) {
                    if (a.publicKey === b.publicKey) {
                        throw new Error(
                            `The balance and public key of both delegates are identical! Delegate "${a.getAttribute(
                                "delegate.username",
                            )}" appears twice in the list.`,
                        );
                    }

                    return a.publicKey.localeCompare(b.publicKey, "en");
                }

                return diff;
            })
            .map(
                (delegate, i): State.IWallet => {
                    const rank = i + 1;
                    delegate.setAttribute("delegate.rank", rank);
                    return delegate;
                },
            );

        if (roundInfo) {
            delegatesSorted = delegatesSorted.slice(0, roundInfo.maxDelegates);
            for (const delegate of delegatesSorted) {
                delegate.setAttribute("delegate.round", roundInfo.round);
            }

            const { maxDelegates } = roundInfo;

            if (delegatesSorted.length < maxDelegates) {
                throw new Error(
                    `Expected to find ${maxDelegates} delegates but only found ${delegatesSorted.length}. ` +
                        `This indicates an issue with the genesis block & delegates.`,
                );
            }

            this.logger.debug(`Loaded ${delegatesSorted.length} active ${pluralize("delegate", delegatesSorted.length)}`);
        }

        return delegatesSorted;
    }


    private async setForgingDelegatesOfRound(roundInfo: Shared.IRoundInfo, delegates?: State.IWallet[]): Promise<void> {
        this.forgingDelegates = await this.getActiveDelegates(roundInfo, delegates);
    }

    private async calcPreviousActiveDelegates(
        roundInfo: Shared.IRoundInfo,
        blocks?: Interfaces.IBlock[],
    ): Promise<State.IWallet[]> {
        blocks = blocks || (await this.databaseService.getBlocksForRound(roundInfo));

        const tempWalletManager = this.walletManager.clone();

        // Revert all blocks in reverse order
        const index: number = blocks.length - 1;

        let height: number = 0;
        for (let i = index; i >= 0; i--) {
            height = blocks[i].data.height;

            if (height === 1) {
                break;
            }

            await tempWalletManager.revertBlock(blocks[i]);
        }

        const delegates: State.IWallet[] = this.buildDelegateRanking(roundInfo);

        for (const delegate of tempWalletManager.allByUsername()) {
            const delegateWallet = this.walletManager.findByUsername(delegate.getAttribute("delegate.username"));
            delegateWallet.setAttribute("delegate.rank", delegate.getAttribute("delegate.rank"));
        }

        return delegates;
    }
}
