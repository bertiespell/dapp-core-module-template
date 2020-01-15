import { app } from "@arkecosystem/core-container";
import { Blockchain, Database, Logger, P2P, Shared, State } from "@arkecosystem/core-interfaces";
import { IDatabaseService } from "@arkecosystem/core-interfaces/dist/core-database";
import { Wallets } from "@arkecosystem/core-state";
import { roundCalculator } from "@arkecosystem/core-utils";
import { Blocks, Crypto, Enums, Identities, Interfaces, Utils } from "@arkecosystem/crypto";
import assert from "assert";
import cloneDeep from "lodash.clonedeep";
import pluralize from "pluralize";
import { inspect } from "util";

export class DappManager {
    private blocksInCurrentRound: Interfaces.IBlock[] = undefined;
    private forgingDelegates: State.IWallet[] = undefined;

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

    public async initialize(genesis = false): Promise<void> {
        this.buildVoteBalances();
        this.buildDelegateRanking();

        if (genesis) {
            const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(1);
            const delegates: State.IWallet[] = this.buildDelegateRanking(roundInfo);
    
            this.forgingDelegates = await this.getActiveDelegates(
                roundInfo,
                delegates,
            );
        }
    }

    public async shutdown(height: number): Promise<void> {
        const roundInfo = roundCalculator.calculateRound(height);
        await this.deleteRound(roundInfo.round);
    }

    public async restoreBlock(height: number): Promise<void> {
        await this.initializeActiveDelegates(height);
        await this.applyRound(height);
    }

    public async verifyBlock(block, startHeight): Promise<boolean> {
        const roundInfo = roundCalculator.calculateRound(startHeight);

        return !!await this.getDelegatesByRound(roundInfo)[block.data.generatorPublicKey]; 
    }

    /**
     * Once a round is finished
     */
    public async loadNextBlock(lastHeight: number) {
        const deleteRoundsAfter: number = roundCalculator.calculateRound(lastHeight).round;

        await this.deleteRound(deleteRoundsAfter + 1);
        await this.loadBlocksFromCurrentRound();
    }

    public async validateGenerator(block: Interfaces.IBlock): Promise<boolean> {
        const database: Database.IDatabaseService = app.resolvePlugin<Database.IDatabaseService>("database");
        const logger: Logger.ILogger = app.resolvePlugin<Logger.ILogger>("logger");
    
        const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(block.data.height);
        const delegates: State.IWallet[] = await this.getActiveDelegates(roundInfo);
        const slot: number = Crypto.Slots.getSlotNumber(block.data.timestamp);
        const forgingDelegate: State.IWallet = delegates[slot % delegates.length];
    
        const generatorUsername: string = database.walletManager
            .findByPublicKey(block.data.generatorPublicKey)
            .getAttribute("delegate.username");
    
        if (!forgingDelegate) {
            logger.debug(
                `Could not decide if delegate ${generatorUsername} (${
                    block.data.generatorPublicKey
                }) is allowed to forge block ${block.data.height.toLocaleString()}`,
            );
        } else if (forgingDelegate.publicKey !== block.data.generatorPublicKey) {
            const forgingUsername: string = database.walletManager
                .findByPublicKey(forgingDelegate.publicKey)
                .getAttribute("delegate.username");
    
            logger.warn(
                `Delegate ${generatorUsername} (${block.data.generatorPublicKey}) not allowed to forge, should be ${forgingUsername} (${forgingDelegate.publicKey})`,
            );
    
            return false;
        }
        logger.debug(
            `Delegate ${generatorUsername} (${
                block.data.generatorPublicKey
            }) allowed to forge block ${block.data.height.toLocaleString()}`,
        );
    
        return true;
    };

    /**
     * Updates the vote balances of the respective delegates of sender and recipient.
     * If the transaction is not a vote...
     * 1. fee + amount is removed from the sender's delegate vote balance
     * 2. amount is added to the recipient's delegate vote balance
     * 
     * in case of a vote...
     * 1. the full sender balance is added to the sender's delegate vote balance
     * If revert is set to true, the operations are reversed (plus -> minus, minus -> plus).
     * @param sender 
     * @param recipient 
     * @param transaction 
     * @param lockWallet 
     * @param lockTransaction 
     * @param revert 
     */
    public addTransaction(
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

    /**
     * TODO: private
     */
    public async getCurrentRound(): Promise<P2P.ICurrentRound> {
        const config = app.getConfig();
        const blockchain = app.resolvePlugin<Blockchain.IBlockchain>("blockchain");
    
        const lastBlock = blockchain.getLastBlock();
    
        const height = lastBlock.data.height + 1;
        const roundInfo = roundCalculator.calculateRound(height);
        const { maxDelegates, round } = roundInfo;
    
        const blockTime = config.getMilestone(height).blocktime;
        const reward = config.getMilestone(height).reward;
        const delegates = await this.getActiveDelegates(roundInfo);
        const timestamp = Crypto.Slots.getTime();
        const blockTimestamp = Crypto.Slots.getSlotNumber(timestamp) * blockTime;
        const currentForger = parseInt((timestamp / blockTime) as any) % maxDelegates;
        const nextForger = (parseInt((timestamp / blockTime) as any) + 1) % maxDelegates;
    
        return {
            current: round,
            reward,
            timestamp: blockTimestamp,
            delegates,
            currentForger: delegates[currentForger],
            nextForger: delegates[nextForger],
            lastBlock: lastBlock.data,
            canForge: parseInt((1 + lastBlock.data.timestamp / blockTime) as any) * blockTime < timestamp - 1,
        };
    }

    public async applyBlock(height: number): Promise<void> {
        const nextHeight: number = height === 1 ? 1 : height + 1;

        if (roundCalculator.isNewRound(nextHeight)) {
            const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(nextHeight);
            const { round } = roundInfo;

            if (
                nextHeight === 1 ||
                !this.forgingDelegates ||
                this.forgingDelegates.length === 0 ||
                this.forgingDelegates[0].getAttribute<number>("delegate.round") !== round
            ) {
                this.logger.info(`Starting Round ${roundInfo.round.toLocaleString()}`);

                try {
                    if (nextHeight > 1) {
                        this.detectMissedRound(this.forgingDelegates);
                    }

                    const delegates: State.IWallet[] = await this.updateDelegates(roundInfo);
                    
                    await this.saveRound(delegates);

                    this.blocksInCurrentRound = [];

                    // this.emitter.emit(ApplicationEvents.RoundApplied);
                } catch (error) {
                    // trying to leave database state has it was
                    await this.deleteRound(round);

                    throw error;
                }
            } else {
                this.logger.warn(
                    // tslint:disable-next-line:max-line-length
                    `Round ${round.toLocaleString()} has already been applied. This should happen only if you are a forger.`,
                );
            }
        }
    }

    public async revertBlock(block: Interfaces.IBlock): Promise<void> {
        await this.revertRound(block);
        await this.revertBalances(block);
    }

    private async revertBalances(block: Interfaces.IBlock): Promise<void> {
        
        const delegate: State.IWallet = this.walletManager.findByPublicKey(block.data.generatorPublicKey);
        const revertedTransactions: Interfaces.ITransaction[] = [];

        try {
            // Revert the transactions from last to first
            for (let i = block.transactions.length - 1; i >= 0; i--) {
                const transaction: Interfaces.ITransaction = block.transactions[i];
                const sender: State.IWallet = this.walletManager.findByPublicKey( transaction.data.senderPublicKey);
                const recipient: State.IWallet = this.walletManager.findByAddress(transaction.data.recipientId);

                let lockWallet: State.IWallet;
                let lockTransaction: Interfaces.ITransactionData;
                if (
                    transaction.type === Enums.TransactionType.HtlcClaim &&
                    transaction.typeGroup === Enums.TransactionTypeGroup.Core
                ) {
                    const lockId = transaction.data.asset.claim.lockTransactionId;
                    lockWallet = this.walletManager.findByIndex(State.WalletIndexes.Locks, lockId);
                    lockTransaction = lockWallet.getAttribute("htlc.locks", {})[lockId];
                }

                await this.addTransaction(sender, recipient, transaction.data, lockWallet, lockTransaction, true);
                revertedTransactions.push(transaction);
            }

            const reverted: boolean = delegate.revertBlock(block.data);

            // If the block has been reverted, the balance is decreased
            // by reward + totalFee. In which case the vote balance of the
            // delegate's delegate has to be updated.
            if (reverted && delegate.hasVoted()) {
                // TODO: move to manager
                const decrease: Utils.BigNumber = block.data.reward.plus(block.data.totalFee);
                const votedDelegate: State.IWallet = this.walletManager.findByPublicKey(delegate.getAttribute<string>("vote"));
                const voteBalance: Utils.BigNumber = votedDelegate.getAttribute("delegate.voteBalance");
                votedDelegate.setAttribute("delegate.voteBalance", voteBalance.minus(decrease));
            }
        } catch (error) {
            this.logger.error(error.stack);

            for (const transaction of revertedTransactions.reverse()) {
                const sender: State.IWallet = this.walletManager.findByPublicKey( transaction.data.senderPublicKey);
                const recipient: State.IWallet = this.walletManager.findByAddress(transaction.data.recipientId);

                let lockWallet: State.IWallet;
                let lockTransaction: Interfaces.ITransactionData;
                if (
                    transaction.type === Enums.TransactionType.HtlcClaim &&
                    transaction.typeGroup === Enums.TransactionTypeGroup.Core
                ) {
                    const lockId = transaction.data.asset.claim.lockTransactionId;
                    lockWallet = this.walletManager.findByIndex(State.WalletIndexes.Locks, lockId);
                    lockTransaction = lockWallet.getAttribute("htlc.locks", {})[lockId];
                }

                await this.addTransaction(sender, recipient, transaction.data, lockWallet, lockTransaction);
            }

            throw error;
        }
    }

    private async revertRound(block: Interfaces.IBlock): Promise<void> {
        const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(block.data.height);
        const { round, nextRound, maxDelegates } = roundInfo;

        if (nextRound === round + 1 && block.data.height >= maxDelegates) {
            this.logger.info(`Back to previous round: ${round.toLocaleString()}`);

            this.blocksInCurrentRound = await this.getBlocksForRound(roundInfo);

            await this.updateForgingDelegatesOfRound(roundInfo, this.blocksInCurrentRound);

            await this.deleteRound(nextRound);
        }

        assert(this.blocksInCurrentRound.pop().data.id === block.data.id);
    }

    private async initializeActiveDelegates(height: number): Promise<void> {
        this.forgingDelegates = undefined;

        const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(height)

        await this.setForgingDelegatesOfRound(roundInfo, await this.calcPreviousActiveDelegates(roundInfo));
    }

    private async applyRound(height: number): Promise<void> {
        const nextHeight: number = height === 1 ? 1 : height + 1;

        if (roundCalculator.isNewRound(nextHeight)) {
            const roundInfo: Shared.IRoundInfo = roundCalculator.calculateRound(nextHeight);
            const { round } = roundInfo;

            if (
                nextHeight === 1 ||
                !this.forgingDelegates ||
                this.forgingDelegates.length === 0 ||
                this.forgingDelegates[0].getAttribute<number>("delegate.round") !== round
            ) {
                this.logger.info(`Starting Round ${roundInfo.round.toLocaleString()}`);

                try {
                    if (nextHeight > 1) {
                        this.detectMissedRound(this.forgingDelegates);
                    }

                    const delegates: State.IWallet[] = await this.updateDelegates(roundInfo);
                    
                    await this.saveRound(delegates);

                    this.blocksInCurrentRound = [];

                    // this.emitter.emit(ApplicationEvents.RoundApplied);
                } catch (error) {
                    // trying to leave database state has it was
                    await this.deleteRound(round);

                    throw error;
                }
            } else {
                this.logger.warn(
                    // tslint:disable-next-line:max-line-length
                    `Round ${round.toLocaleString()} has already been applied. This should happen only if you are a forger.`,
                );
            }
        }
    }

    private async updateForgingDelegatesOfRound(roundInfo: Shared.IRoundInfo, blocks: Interfaces.IBlock[]): Promise<void> {
        this.setForgingDelegatesOfRound(roundInfo,
            await this.calcPreviousActiveDelegates(roundInfo, blocks))
    }

    private async setForgingDelegatesOfRound(roundInfo: Shared.IRoundInfo, delegates?: State.IWallet[]): Promise<void> {
        this.forgingDelegates = await this.getActiveDelegates(roundInfo, delegates);
    }

    private async calcPreviousActiveDelegates(
        roundInfo: Shared.IRoundInfo,
        blocks?: Interfaces.IBlock[],
    ): Promise<State.IWallet[]> {
        blocks = blocks || (await this.getBlocksForRound(roundInfo));

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

    private async saveRound(activeDelegates: State.IWallet[]): Promise<void> {
        this.logger.info(`Saving round ${activeDelegates[0].getAttribute("delegate.round").toLocaleString()}`);

        // await this.connection.roundsRepository.insert(activeDelegates);

        // this.emitter.emit(ApplicationEvents.RoundCreated, activeDelegates);
    }

    private detectMissedRound(delegates: State.IWallet[]): void {
        if (!delegates || !this.blocksInCurrentRound) {
            return;
        }

        if (this.blocksInCurrentRound.length === 1 && this.blocksInCurrentRound[0].data.height === 1) {
            return;
        }

        for (const delegate of delegates) {
            const producedBlocks: Interfaces.IBlock[] = this.blocksInCurrentRound.filter(
                blockGenerator => blockGenerator.data.generatorPublicKey === delegate.publicKey,
            );

            if (producedBlocks.length === 0) {
                const wallet: State.IWallet = this.walletManager.findByPublicKey(delegate.publicKey);

                this.logger.debug(
                    `Delegate ${wallet.getAttribute("delegate.username")} (${wallet.publicKey}) just missed a round.`,
                );

                // this.emitter.emit(ApplicationEvents.RoundMissed, {
                //     delegate: wallet,
                // });
            }
        }
    }

    private async updateDelegates(roundInfo?: Shared.IRoundInfo): Promise<State.IWallet[]> {
        const delegates = this.buildDelegateRanking(roundInfo);
        this.forgingDelegates = await this.getActiveDelegates(roundInfo, delegates);
        return delegates;
    }

    private async getBlocksForRound(roundInfo?: Shared.IRoundInfo): Promise<Interfaces.IBlock[]> {
        let lastBlock: Interfaces.IBlock = app
            .resolvePlugin<State.IStateService>("state")
            .getStore()
            .getLastBlock();

        if (!lastBlock) {
            lastBlock = await this.databaseService.getLastBlock();
        }

        if (!lastBlock) {
            return [];
        } else if (lastBlock.data.height === 1) {
            return [lastBlock];
        }

        if (!roundInfo) {
            roundInfo = roundCalculator.calculateRound(lastBlock.data.height);
        }

        return (await this.databaseService.getBlocks(roundInfo.roundHeight, roundInfo.maxDelegates)).map(
            (block: Interfaces.IBlockData) => {
                if (block.height === 1) {
                    return app
                        .resolvePlugin<State.IStateService>("state")
                        .getStore()
                        .getGenesisBlock();
                }

                return Blocks.BlockFactory.fromData(block, { deserializeTransactionsUnchecked: true });
            },
        );
    }

    private async deleteRound(round: number): Promise<void> {
        // await this.connection.roundsRepository.delete(round);
    }

    private async loadBlocksFromCurrentRound(): Promise<void> {
        this.blocksInCurrentRound = await this.getBlocksForRound();
    }

    private async getDelegatesByRound(roundInfo: Shared.IRoundInfo): Promise<Record<string, State.IWallet>> {
        const { round, maxDelegates } = roundInfo;

        let delegates = await this.getActiveDelegates(roundInfo);

        if (delegates.length === 0) {
            // This must be the current round, still not saved into the database (it is saved
            // only after it has completed). So fetch the list of delegates from the wallet
            // manager.

            delegates = this.buildDelegateRanking(roundInfo);
            assert.strictEqual(
                delegates.length,
                maxDelegates,
                `Couldn't derive the list of delegates for round ${round}. The database ` +
                    `returned empty list and the wallet manager returned ${this.anyToString(delegates)}.`,
            );
        }

        const delegatesByPublicKey = {} as Record<string, State.IWallet>;

        for (const delegate of delegates) {
            delegatesByPublicKey[delegate.publicKey] = delegate;
        }

        return delegatesByPublicKey;
    }

    /**
     * Format an arbitrary value to a string.
     * @param {*} val value to be converted
     * @return {String} string representation of `val`
     */
    private anyToString(val: any): string {
        return inspect(val, { sorted: true, breakLength: Infinity });
    }

    private async getActiveDelegates(
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

    private buildVoteBalances(): void {
        for (const voter of this.walletManager.allByPublicKey()) {
            if (voter.hasVoted()) {
                const delegate: State.IWallet = this.walletManager.findByPublicKey(voter.getAttribute<string>("vote"));
                const voteBalance: Utils.BigNumber = delegate.getAttribute("delegate.voteBalance");
                const lockedBalance = voter.getAttribute("htlc.lockedBalance", Utils.BigNumber.ZERO);
                delegate.setAttribute("delegate.voteBalance", voteBalance.plus(voter.balance).plus(lockedBalance));
            }
        }
    }

    private buildDelegateRanking(roundInfo?: Shared.IRoundInfo): State.IWallet[] {
        
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
}
