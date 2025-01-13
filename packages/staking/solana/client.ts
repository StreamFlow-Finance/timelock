import {
  AccountsCoder,
  AnchorError,
  Idl,
  IdlTypes,
  Program,
  ProgramAccount,
  ProgramError,
  parseIdlErrors,
  translateError,
} from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Commitment, Connection, ConnectionConfig, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ContractError, ICluster, ITransactionResult, invariant } from "@streamflow/common";
import {
  buildSendThrottler,
  checkOrCreateAtaBatch,
  getFilters,
  pk,
  prepareBaseInstructions,
  prepareTransaction,
  signAndExecuteTransaction,
} from "@streamflow/common/solana";
import PQueue from "p-queue";

import {
  REWARD_ENTRY_BYTE_OFFSETS,
  REWARD_POOL_BYTE_OFFSETS,
  REWARD_POOL_PROGRAM_ID,
  STAKE_ENTRY_BYTE_OFFSETS,
  STAKE_POOL_BYTE_OFFSETS,
  STAKE_POOL_PROGRAM_ID,
  STREAMFLOW_TREASURY_PUBLIC_KEY,
} from "./constants.js";
import { FeeManager as FeeManagerProgramType } from "./descriptor/fee_manager.js";
import FeeManagerIDL from "./descriptor/idl/fee_manager.json";
import RewardPoolIDL from "./descriptor/idl/reward_pool.json";
import StakePoolIDL from "./descriptor/idl/stake_pool.json";
import { RewardPool as RewardPoolProgramType } from "./descriptor/reward_pool.js";
import { StakePool as StakePoolProgramType } from "./descriptor/stake_pool.js";
import {
  deriveConfigPDA,
  deriveFeeValuePDA,
  deriveRewardPoolPDA,
  deriveRewardVaultPDA,
  deriveStakeEntryPDA,
  deriveStakeMintPDA,
  deriveStakePoolPDA,
} from "./lib/derive-accounts.js";
import {
  ClaimRewardPoolArgs,
  CreateRewardEntryArgs,
  CreateRewardPoolArgs,
  CreateStakePoolArgs,
  DefaultFeeValueConfig,
  FeeValue,
  FundPoolArgs,
  IInteractSolanaExt,
  RewardEntry,
  RewardPool,
  StakeArgs,
  StakeEntry,
  StakePool,
  UnstakeArgs,
  UpdateRewardPoolArgs,
} from "./types.js";

interface Programs {
  stakePoolProgram: Program<StakePoolProgramType>;
  rewardPoolProgram: Program<RewardPoolProgramType>;
  feeManagerProgram: Program<FeeManagerProgramType>;
}

type CreationResult = ITransactionResult & { metadataId: PublicKey };

interface IInitOptions {
  clusterUrl: string;
  cluster?: ICluster;
  commitment?: Commitment | ConnectionConfig;
  programIds?: {
    stakePool?: string;
    rewardPool?: string;
    feeManager?: string;
  };
  sendRate?: number;
  sendThrottler?: PQueue;
}

export class SolanaStakingClient {
  connection: Connection;

  private commitment: Commitment | ConnectionConfig;

  private sendThrottler: PQueue;

  private programs: Programs;

  constructor({
    clusterUrl,
    cluster = ICluster.Mainnet,
    commitment = "confirmed",
    programIds,
    sendRate = 1,
    sendThrottler,
  }: IInitOptions) {
    this.commitment = commitment;
    this.connection = new Connection(clusterUrl, this.commitment);
    this.sendThrottler = sendThrottler ?? buildSendThrottler(sendRate);
    const stakePoolIdl = {
      ...StakePoolIDL,
      address: programIds?.stakePool ?? STAKE_POOL_PROGRAM_ID[cluster] ?? StakePoolIDL.address,
    } as StakePoolProgramType;
    const rewardPoolIdl = {
      ...RewardPoolIDL,
      address: programIds?.rewardPool ?? REWARD_POOL_PROGRAM_ID[cluster] ?? RewardPoolIDL.address,
    } as RewardPoolProgramType;
    const feeManagerIdl = {
      ...FeeManagerIDL,
      address: programIds?.feeManager ?? FeeManagerIDL.address,
    } as FeeManagerProgramType;
    this.programs = {
      stakePoolProgram: new Program(stakePoolIdl, {
        connection: this.connection,
      }) as Program<StakePoolProgramType>,
      rewardPoolProgram: new Program(rewardPoolIdl, {
        connection: this.connection,
      }) as Program<RewardPoolProgramType>,
      feeManagerProgram: new Program(feeManagerIdl, {
        connection: this.connection,
      }) as Program<FeeManagerProgramType>,
    };
  }

  getCurrentProgramId(programKey: keyof Programs): PublicKey {
    const program = this.programs[programKey];
    invariant(program, `Program ${programKey} is not found`);
    return program.programId;
  }

  getCommitment(): Commitment | undefined {
    return typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
  }

  async getStakePool(id: string | PublicKey): Promise<StakePool> {
    const { stakePoolProgram } = this.programs;
    return stakePoolProgram.account.stakePool.fetch(id);
  }

  async searchStakePools(
    criteria: Partial<Pick<StakePool, keyof typeof STAKE_POOL_BYTE_OFFSETS>> = {},
  ): Promise<ProgramAccount<StakePool>[]> {
    const { stakePoolProgram } = this.programs;
    return stakePoolProgram.account.stakePool.all(getFilters(criteria, STAKE_POOL_BYTE_OFFSETS));
  }

  async getStakeEntry(id: string | PublicKey): Promise<StakeEntry | null> {
    const { stakePoolProgram } = this.programs;
    return stakePoolProgram.account.stakeEntry.fetch(id);
  }

  async searchStakeEntries(
    criteria: Partial<Pick<StakeEntry, keyof typeof STAKE_ENTRY_BYTE_OFFSETS>> = {},
  ): Promise<ProgramAccount<StakeEntry>[]> {
    const { stakePoolProgram } = this.programs;
    return stakePoolProgram.account.stakeEntry.all(getFilters(criteria, STAKE_ENTRY_BYTE_OFFSETS));
  }

  async searchRewardPools(
    criteria: Partial<Pick<RewardPool, "stakePool" | "mint">> = {},
  ): Promise<ProgramAccount<RewardPool>[]> {
    const { rewardPoolProgram } = this.programs;
    return rewardPoolProgram.account.rewardPool.all(getFilters(criteria, REWARD_POOL_BYTE_OFFSETS));
  }

  async searchRewardEntries(
    criteria: Partial<Pick<RewardEntry, keyof typeof REWARD_ENTRY_BYTE_OFFSETS>>,
  ): Promise<ProgramAccount<RewardEntry>[]> {
    const { rewardPoolProgram } = this.programs;
    return rewardPoolProgram.account.rewardEntry.all(getFilters(criteria, REWARD_ENTRY_BYTE_OFFSETS));
  }

  async getFee(target: string | PublicKey): Promise<FeeValue | DefaultFeeValueConfig> {
    const perTargetFee = await this.getFeeValueIfExists(target);
    if (perTargetFee) {
      return perTargetFee;
    }
    return this.getDefaultFeeValue();
  }

  getDefaultFeeValue(): Promise<DefaultFeeValueConfig> {
    const { feeManagerProgram } = this.programs;
    const feeValueKey = deriveConfigPDA(feeManagerProgram.programId);
    return feeManagerProgram.account.config.fetch(feeValueKey);
  }

  getFeeValueIfExists(target: string | PublicKey): Promise<FeeValue | null> {
    const { feeManagerProgram } = this.programs;
    const feeValueKey = deriveFeeValuePDA(feeManagerProgram.programId, new PublicKey(target));
    return feeManagerProgram.account.feeValue.fetchNullable(feeValueKey);
  }

  async createStakePool(data: CreateStakePoolArgs, extParams: IInteractSolanaExt): Promise<CreationResult> {
    const { ixs, publicKey } = await this.prepareCreateStakePoolInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
      metadataId: publicKey,
    };
  }

  async prepareCreateStakePoolInstructions(
    {
      maxWeight,
      maxDuration,
      minDuration,
      mint,
      permissionless = false,
      nonce,
      tokenProgramId = TOKEN_PROGRAM_ID,
    }: CreateStakePoolArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { stakePoolProgram } = this.programs;
    const creator = extParams.invoker.publicKey;
    invariant(creator, "Undefined invoker publicKey");
    const createInstruction = await stakePoolProgram.methods
      .createPool(nonce, maxWeight, minDuration, maxDuration, permissionless)
      .accounts({
        creator,
        mint,
        tokenProgram: tokenProgramId,
      })
      .instruction();

    const stakePoolPDA = deriveStakePoolPDA(stakePoolProgram.programId, pk(mint), creator, nonce);

    return {
      ixs: [...prepareBaseInstructions(this.connection, extParams), createInstruction],
      publicKey: stakePoolPDA,
    };
  }

  async stake(data: StakeArgs, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const { ixs } = await this.prepareStakeInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareStakeInstructions(
    { nonce, amount, duration, stakePool, stakePoolMint, tokenProgramId = TOKEN_PROGRAM_ID }: StakeArgs,
    extParams: IInteractSolanaExt,
  ): Promise<{
    ixs: TransactionInstruction[];
  }> {
    const { stakePoolProgram } = this.programs;
    const staker = extParams.invoker.publicKey;
    invariant(staker, "Undefined invoker publicKey");
    const mint = deriveStakeMintPDA(stakePoolProgram.programId, pk(stakePool));
    const stakeMintAccountKey = getAssociatedTokenAddressSync(mint, staker, true, pk(tokenProgramId));
    const poolMintAccountKey = getAssociatedTokenAddressSync(pk(stakePoolMint), staker, true, pk(tokenProgramId));
    const instruction = await stakePoolProgram.methods
      .stake(nonce, amount, duration)
      .accounts({
        stakePool: stakePool,
        tokenProgram: tokenProgramId,
        from: poolMintAccountKey,
        to: stakeMintAccountKey,
        authority: staker,
        payer: staker,
      })
      .instruction();

    return { ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  async unstake(data: UnstakeArgs, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const { ixs } = await this.prepareUnstakeInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareUnstakeInstructions(
    { stakePool, stakePoolMint, nonce, tokenProgramId = TOKEN_PROGRAM_ID }: UnstakeArgs,
    extParams: IInteractSolanaExt,
  ): Promise<{
    ixs: TransactionInstruction[];
  }> {
    const { stakePoolProgram } = this.programs;
    const staker = extParams.invoker.publicKey;
    invariant(staker, "Undefined invoker publicKey");
    const stakeMintKey = deriveStakeMintPDA(stakePoolProgram.programId, pk(stakePool));
    const stakeEntryKey = deriveStakeEntryPDA(stakePoolProgram.programId, pk(stakePool), staker, nonce);
    const poolMintAccountKey = getAssociatedTokenAddressSync(pk(stakePoolMint), staker, true, pk(tokenProgramId));
    const stakeMintAccountKey = getAssociatedTokenAddressSync(stakeMintKey, staker, true, pk(tokenProgramId));
    const instruction = await stakePoolProgram.methods
      .unstake()
      .accounts({
        stakeEntry: stakeEntryKey,
        to: poolMintAccountKey,
        from: stakeMintAccountKey,
        authority: staker,
        tokenProgram: tokenProgramId,
      })
      .instruction();

    return { ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  async createRewardPool(data: CreateRewardPoolArgs, extParams: IInteractSolanaExt): Promise<CreationResult> {
    const { ixs, publicKey } = await this.prepareCreateRewardPoolInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
      metadataId: publicKey,
    };
  }

  async prepareCreateRewardPoolInstructions(
    {
      nonce,
      rewardAmount,
      rewardPeriod,
      rewardMint,
      permissionless = false,
      stakePool,
      lastClaimPeriodOpt,
      tokenProgramId = TOKEN_PROGRAM_ID,
    }: CreateRewardPoolArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { rewardPoolProgram } = this.programs;
    const creator = extParams.invoker.publicKey;
    invariant(creator, "Undefined invoker publicKey");
    const instruction = await rewardPoolProgram.methods
      .createPool(nonce, rewardAmount, rewardPeriod, permissionless, lastClaimPeriodOpt)
      .accounts({
        creator,
        stakePool,
        mint: rewardMint,
        tokenProgram: tokenProgramId,
      })
      .instruction();

    const rewardPoolKey = deriveRewardPoolPDA(rewardPoolProgram.programId, pk(stakePool), pk(rewardMint), nonce);

    return { publicKey: rewardPoolKey, ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  async claimRewards(data: ClaimRewardPoolArgs, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const { ixs } = await this.prepareClaimRewardsInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareClaimRewardsInstructions(
    { rewardPoolNonce, depositNonce, stakePool, tokenProgramId = TOKEN_PROGRAM_ID, rewardMint }: ClaimRewardPoolArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { stakePoolProgram, rewardPoolProgram } = this.programs;
    const staker = extParams.invoker.publicKey;
    invariant(staker, "Undefined invoker publicKey");
    const instruction = await rewardPoolProgram.methods
      .claimRewards()
      .accounts({
        stakeEntry: deriveStakeEntryPDA(stakePoolProgram.programId, pk(stakePool), staker, depositNonce),
        rewardPool: deriveRewardPoolPDA(rewardPoolProgram.programId, pk(stakePool), pk(rewardMint), rewardPoolNonce),
        claimant: staker,
        tokenProgram: tokenProgramId,
        to: getAssociatedTokenAddressSync(pk(rewardMint), staker, true, pk(tokenProgramId)),
      })
      .instruction();

    return { ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  async fundPool(data: FundPoolArgs, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const { ixs } = await this.prepareFundPoolInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareFundPoolInstructions(
    { amount, tokenProgramId = TOKEN_PROGRAM_ID, rewardMint, stakePool, feeValue, nonce }: FundPoolArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { rewardPoolProgram } = this.programs;
    const staker = extParams.invoker.publicKey;
    invariant(staker, "Undefined invoker publicKey");
    const existingFee = await this.getFeeValueIfExists(staker);
    const rewardMintPk = pk(rewardMint);
    const tokenProgramPk = pk(tokenProgramId);
    const treasuryATA =
      !existingFee || existingFee.streamflowFee.gtn(0)
        ? await checkOrCreateAtaBatch(
            this.connection,
            [STREAMFLOW_TREASURY_PUBLIC_KEY],
            rewardMintPk,
            extParams.invoker,
            tokenProgramPk,
          )
        : null;
    const rewardPoolPda = deriveRewardPoolPDA(rewardPoolProgram.programId, pk(stakePool), rewardMintPk, nonce);
    const instruction = await rewardPoolProgram.methods
      .fundPool(amount)
      .accountsPartial({
        funder: staker,
        rewardPool: rewardPoolPda,
        from: getAssociatedTokenAddressSync(rewardMintPk, staker, true, tokenProgramPk),
        tokenProgram: tokenProgramId,
        vault: deriveRewardVaultPDA(rewardPoolProgram.programId, rewardPoolPda),
        mint: rewardMint,
        feeValue,
      })
      .instruction();

    const instructions = [...prepareBaseInstructions(this.connection, extParams), instruction];
    return {
      ixs: treasuryATA ? treasuryATA.concat(instructions) : instructions,
    };
  }

  async createRewardEntry(data: CreateRewardEntryArgs, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const { ixs } = await this.prepareCreateRewardEntryInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareCreateRewardEntryInstructions(
    { stakePool, rewardPoolNonce, depositNonce, rewardMint }: CreateRewardEntryArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { stakePoolProgram, rewardPoolProgram } = this.programs;
    const staker = extParams.invoker.publicKey;
    invariant(staker, "Undefined invoker publicKey");
    const instruction = await rewardPoolProgram.methods
      .createEntry()
      .accounts({
        payer: staker,
        authority: staker,
        stakeEntry: deriveStakeEntryPDA(stakePoolProgram.programId, pk(stakePool), staker, depositNonce),
        rewardPool: deriveRewardPoolPDA(rewardPoolProgram.programId, pk(stakePool), pk(rewardMint), rewardPoolNonce),
      })
      .instruction();

    return { ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  async updateRewardPool(data: UpdateRewardPoolArgs, extParams: IInteractSolanaExt) {
    const { ixs } = await this.prepareUpdateRewardPoolInstructions(data, extParams);
    const { signature } = await this.execute(ixs, extParams);

    return {
      ixs,
      txId: signature,
    };
  }

  async prepareUpdateRewardPoolInstructions(
    { rewardPool, rewardAmount, rewardPeriod, stakePool }: UpdateRewardPoolArgs,
    extParams: IInteractSolanaExt,
  ) {
    const { rewardPoolProgram } = this.programs;
    const invoker = extParams.invoker.publicKey;
    invariant(invoker, "Undefined invoker publicKey");
    const instruction = await rewardPoolProgram.methods
      .updatePool(rewardAmount, rewardPeriod)
      .accountsPartial({
        stakePool,
        authority: invoker,
        rewardPool,
      })
      .instruction();

    return { ixs: [...prepareBaseInstructions(this.connection, extParams), instruction] };
  }

  decode<
    ProgramName extends keyof Programs = keyof Programs,
    DecodingProgram = Programs[ProgramName],
    DerivedIdl extends Idl = DecodingProgram extends Program<infer IDLType> ? IDLType : never,
    AccountName extends keyof IdlTypes<DerivedIdl> = keyof IdlTypes<DerivedIdl>,
    DecodedAccount = IdlTypes<DerivedIdl>[AccountName],
  >(
    programKey: ProgramName,
    accountName: AccountName,
    accInfo: Parameters<AccountsCoder["decode"]>[1],
  ): DecodedAccount {
    const decodingProgram = this.programs[programKey];
    invariant(decodingProgram, `Decoding program with key ${programKey} is not available`);
    return decodingProgram.coder.accounts.decode(accountName.toString(), accInfo);
  }

  getDiscriminator<
    ProgramName extends keyof Programs = keyof Programs,
    DecodingProgram = Programs[ProgramName],
    DerivedIdl extends Idl = DecodingProgram extends Program<infer IDLType> ? IDLType : never,
    AccountName extends keyof IdlTypes<DerivedIdl> = keyof IdlTypes<DerivedIdl>,
  >(programKey: ProgramName, accountName: AccountName): number[] {
    const decodingProgram = this.programs[programKey];
    invariant(decodingProgram, `Decoding program with key ${programKey} is not available`);
    const accountEntity = decodingProgram.idl.accounts.find((acc) => acc.name === accountName);
    invariant(
      accountEntity,
      `Decoding program with key ${programKey} doesn't specify account with name ${accountName.toString()}`,
    );
    return accountEntity.discriminator;
  }

  private async execute(ixs: TransactionInstruction[], extParams: IInteractSolanaExt) {
    const { tx, hash, context } = await prepareTransaction(
      this.connection,
      prepareBaseInstructions(this.connection, extParams).concat(ixs),
      extParams.invoker.publicKey,
    );

    try {
      const signature = await signAndExecuteTransaction(
        this.connection,
        extParams.invoker,
        tx,
        {
          hash,
          context,
          commitment: this.getCommitment(),
        },
        { sendThrottler: this.sendThrottler },
      );
      return { signature };
    } catch (err: any) {
      if (err instanceof Error) {
        const parsed: AnchorError | ProgramError | typeof err = translateError(
          err,
          parseIdlErrors(this.programs.stakePoolProgram.idl), // TODO how to catch an error from a specific program?
        );
        if (parsed) {
          throw new ContractError(err, parsed.name, parsed.message);
        }
      }
      throw err;
    }
  }
}
