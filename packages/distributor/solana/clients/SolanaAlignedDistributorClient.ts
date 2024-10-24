import BN from "bn.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { getBN, getNumberFromBN, invariant } from "@streamflow/common";

import {
  ICreateAlignedDistributorData,
  AlignedDistributorData,
  NewAlignedDistributorArgs,
  OracleType,
  OracleTypeName,
} from "../types";
import { ClawbackAccounts, NewDistributorAccounts } from "../generated/instructions";
import BaseDistributorClient, { IInitOptions } from "./BaseDistributorClient.js";
import { AlignedDistributor as AlignedAirdropsProgramType } from "../descriptor/aligned_distributor.js";
import StreamflowAlignedAirdropsIDL from "../descriptor/idl/aligned_distributor.json";
import { ALIGNED_PRECISION_FACTOR_POW } from "../constants.js";
import { getAlignedDistributorPda } from "../utils.js";

export default class SolanaAlignedDistributorClient extends BaseDistributorClient {
  private alignedProxyProgram: Program<AlignedAirdropsProgramType>;

  public constructor({ clusterUrl, cluster, commitment, programId, sendRate, sendThrottler }: IInitOptions) {
    super({ clusterUrl, cluster, commitment, programId, sendRate, sendThrottler });
    const alignedAirdropsProgram = {
      ...StreamflowAlignedAirdropsIDL,
    } as AlignedAirdropsProgramType;
    this.alignedProxyProgram = new Program(alignedAirdropsProgram, { connection: this.connection });
  }

  public async getAlignedDistributorData(distributorAddress: string): Promise<AlignedDistributorData | null> {
    const distributorKey = new PublicKey(distributorAddress);
    const alignedDistributorKey = getAlignedDistributorPda(this.alignedProxyProgram.programId, distributorKey);
    const alignedProxy = await this.alignedProxyProgram.account.alignedDistributor.fetch(alignedDistributorKey);
    invariant(alignedProxy, "Aligned Distributor proxy account not found");

    const oracleType = Object.keys(alignedProxy.priceOracleType).find((key) => !!key) as OracleTypeName;

    return {
      oracleType,
      minPrice: getNumberFromBN(alignedProxy.minPrice, ALIGNED_PRECISION_FACTOR_POW),
      maxPrice: getNumberFromBN(alignedProxy.maxPrice, ALIGNED_PRECISION_FACTOR_POW),
      minPercentage: getNumberFromBN(alignedProxy.minPercentage, ALIGNED_PRECISION_FACTOR_POW),
      maxPercentage: getNumberFromBN(alignedProxy.maxPercentage, ALIGNED_PRECISION_FACTOR_POW),
      priceOracle: oracleType === "none" ? undefined : alignedProxy.priceOracle.toBase58(),
      sender: alignedProxy.admin.toBase58(),
      updatePeriod: getNumberFromBN(alignedProxy.updatePeriod, ALIGNED_PRECISION_FACTOR_POW),
      clawedBack: alignedProxy.distributorClawedBack,
    };
  }

  protected async getNewDistributorInstruction(
    data: ICreateAlignedDistributorData,
    accounts: NewDistributorAccounts,
  ): Promise<TransactionInstruction> {
    const { distributor, mint, clawbackReceiver, tokenProgram, tokenVault } = accounts;

    const baseArgs = this.getNewDistributorArgs(data);
    const alignedArgs = this.getNewAlignedDistributorArgs(data);

    const newDistributorIx = await this.alignedProxyProgram.methods
      .newDistributor({
        ...baseArgs,
        ...alignedArgs,
      })
      .accounts({
        tokenVault,
        distributor,
        clawbackReceiver,
        mint,
        tokenProgram,
        priceOracle: new PublicKey(data.oracleAddress),
      })
      .instruction();

    return newDistributorIx;
  }

  protected async getClawbackInstruction(accounts: ClawbackAccounts): Promise<TransactionInstruction> {
    const { distributor, from, to, mint, tokenProgram } = accounts;
    const alignedDistributorKey = getAlignedDistributorPda(this.alignedProxyProgram.programId, distributor);

    const alignedProxy = await this.alignedProxyProgram.account.alignedDistributor.fetch(alignedDistributorKey);
    invariant(alignedProxy, "Aligned Distributor proxy account not found");

    const clawbackInstruction = await this.alignedProxyProgram.methods
      .clawback()
      .accounts({
        distributor,
        from,
        to,
        mint,
        tokenProgram,
      })
      .instruction();

    return clawbackInstruction;
  }

  protected getNewAlignedDistributorArgs(data: ICreateAlignedDistributorData): NewAlignedDistributorArgs {
    const {
      oracleType,
      minPrice,
      maxPrice,
      minPercentage,
      maxPercentage,
      tickSize,
      skipInitial,
      totalAmountLocked,
      totalAmountUnlocked,
    } = data;

    return {
      totalAmountLocked: new BN(totalAmountLocked),
      totalAmountUnlocked: new BN(totalAmountUnlocked),
      oracleType: (!!oracleType ? { [oracleType]: {} } : { none: {} }) as OracleType,
      minPrice: getBN(minPrice, ALIGNED_PRECISION_FACTOR_POW),
      maxPrice: getBN(maxPrice, ALIGNED_PRECISION_FACTOR_POW),
      minPercentage: getBN(minPercentage, ALIGNED_PRECISION_FACTOR_POW),
      maxPercentage: getBN(maxPercentage, ALIGNED_PRECISION_FACTOR_POW),
      tickSize: new BN(tickSize || 1),
      skipInitial: skipInitial ?? false,
      updatePeriod: new BN(30),
    };
  }
}
