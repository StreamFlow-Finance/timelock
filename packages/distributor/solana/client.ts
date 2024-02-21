import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  Commitment,
  ConnectionConfig,
} from "@solana/web3.js";
import { ICluster, ITransactionResult } from "@streamflow/common";
import { ata, checkOrCreateAtaBatch, prepareWrappedAccount } from "@streamflow/common/solana";

import { DISTRIBUTOR_PROGRAM_ID } from "./constants";
import {
  IClaimData,
  IClawbackData,
  ICreateDistributorData,
  ICreateDistributorResult,
  IGetClaimsData,
  IGetDistributors,
  ICreateSolanaExt,
  IInteractSolanaExt,
} from "./types";
import {
  ClaimLockedAccounts,
  ClawbackAccounts,
  NewClaimAccounts,
  NewClaimArgs,
  NewDistributorAccounts,
  NewDistributorArgs,
  claimLocked,
  clawback,
  newClaim,
  newDistributor,
} from "./generated/instructions";
import { ClaimStatus, MerkleDistributor } from "./generated/accounts";
import { getClaimantStatusPda, getDistributorPda, wrappedSignAndExecuteTransaction } from "./utils";

interface IInitOptions {
  clusterUrl: string;
  cluster?: ICluster;
  commitment?: Commitment | ConnectionConfig;
  programId?: string;
}

export default class SolanaDistributorClient {
  private connection: Connection;

  private programId: PublicKey;

  private commitment: Commitment | ConnectionConfig;

  /**
   * Create Stream instance
   */
  constructor({
    clusterUrl,
    cluster = ICluster.Mainnet,
    commitment = "confirmed",
    programId = "",
  }: IInitOptions) {
    this.commitment = commitment;
    this.connection = new Connection(clusterUrl, this.commitment);
    this.programId =
      programId !== "" ? new PublicKey(programId) : new PublicKey(DISTRIBUTOR_PROGRAM_ID[cluster]);
  }

  public async create(
    data: ICreateDistributorData,
    { invoker, isNative = false }: ICreateSolanaExt
  ): Promise<ICreateDistributorResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = [];
    const mint = isNative ? NATIVE_MINT : new PublicKey(data.mint);
    const mintAccount = await getMint(this.connection, mint);
    const distributorPublicKey = getDistributorPda(this.programId, mint, data.version);
    const tokenVault = await ata(mint, distributorPublicKey);
    const senderTokens = await ata(mint, invoker.publicKey);

    const args: NewDistributorArgs = {
      version: new BN(data.version, 10),
      root: data.root,
      maxTotalClaim: data.maxTotalClaim,
      maxNumNodes: data.maxNumNodes,
      unlockPeriod: new BN(data.unlockPeriod, 10),
      startVestingTs: new BN(data.startVestingTs, 10),
      endVestingTs: new BN(data.endVestingTs, 10),
      clawbackStartTs: new BN(data.clawbackStartTs, 10),
      claimsClosable: data.claimsClosable,
    };
    const accounts: NewDistributorAccounts = {
      distributor: distributorPublicKey,
      clawbackReceiver: senderTokens,
      mint,
      tokenVault,
      admin: invoker.publicKey,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    if (isNative) {
      ixs.push(
        ...(await prepareWrappedAccount(this.connection, invoker.publicKey, data.maxTotalClaim))
      );
    }

    ixs.push(newDistributor(args, accounts, this.programId));
    ixs.push(
      createTransferCheckedInstruction(
        senderTokens,
        mint,
        tokenVault,
        invoker.publicKey,
        BigInt(data.maxTotalClaim.toString()),
        mintAccount.decimals
      )
    );

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;

    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);

    const signature = await wrappedSignAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature, metadataId: distributorPublicKey.toBase58() };
  }

  public async claim(
    data: IClaimData,
    { invoker }: IInteractSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const distributorPublicKey = new PublicKey(data.id);
    const distributor = await MerkleDistributor.fetch(this.connection, distributorPublicKey);

    if (!distributor) {
      throw new Error("Couldn't get account info");
    }

    const ixs = await checkOrCreateAtaBatch(
      this.connection,
      [invoker.publicKey],
      distributor.mint,
      invoker
    );
    const invokerTokens = await ata(distributor.mint, invoker.publicKey);
    const claimStatusPublicKey = getClaimantStatusPda(
      this.programId,
      distributorPublicKey,
      invoker.publicKey
    );
    const claimStatus = await ClaimStatus.fetch(this.connection, claimStatusPublicKey);

    const accounts: ClaimLockedAccounts | NewClaimAccounts = {
      distributor: distributorPublicKey,
      claimStatus: claimStatusPublicKey,
      from: distributor.tokenVault,
      to: invokerTokens,
      claimant: invoker.publicKey,
      mint: distributor.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    if (claimStatus) {
      ixs.push(claimLocked(accounts, this.programId));
    } else {
      const args: NewClaimArgs = {
        amountLocked: data.amountLocked,
        amountUnlocked: data.amountUnlocked,
        proof: data.proof,
      };
      ixs.push(newClaim(args, accounts, this.programId));
    }

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);
    const signature = await wrappedSignAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  public async clawback(
    data: IClawbackData,
    { invoker }: IInteractSolanaExt
  ): Promise<ITransactionResult> {
    if (!invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const distributorPublicKey = new PublicKey(data.id);
    const distributor = await MerkleDistributor.fetch(this.connection, distributorPublicKey);

    if (!distributor) {
      throw new Error("Couldn't get account info");
    }

    const ixs = await checkOrCreateAtaBatch(
      this.connection,
      [invoker.publicKey],
      distributor.mint,
      invoker
    );
    const accounts: ClawbackAccounts = {
      distributor: distributorPublicKey,
      from: distributor.tokenVault,
      to: distributor.clawbackReceiver,
      claimant: invoker.publicKey,
      mint: distributor.mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    ixs.push(clawback(accounts, this.programId));

    const commitment =
      typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
    const hash = await this.connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      feePayer: invoker.publicKey,
      blockhash: hash.blockhash,
      lastValidBlockHeight: hash.lastValidBlockHeight,
    }).add(...ixs);
    const signature = await wrappedSignAndExecuteTransaction(this.connection, invoker, tx, hash);

    return { ixs, txId: signature };
  }

  public async getClaims(data: IGetClaimsData): Promise<(ClaimStatus | null)[]> {
    const distributorPublicKey = new PublicKey(data.id);
    const claimStatusPublicKeys = data.recipients.map((recipient) => {
      return getClaimantStatusPda(this.programId, distributorPublicKey, new PublicKey(recipient));
    });
    return ClaimStatus.fetchMultiple(this.connection, claimStatusPublicKeys, this.programId);
  }

  public async getDistributors(data: IGetDistributors): Promise<(MerkleDistributor | null)[]> {
    const distributorPublicKeys = data.ids.map((distributorId) => new PublicKey(distributorId));
    return MerkleDistributor.fetchMultiple(this.connection, distributorPublicKeys, this.programId);
  }
}
