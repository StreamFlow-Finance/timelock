import BigNumber from "bignumber.js";
import { BigNumber as BigNumberEvm } from "ethers";

import { buildStreamType, calculateUnlockedAmount } from "../common/contractUtils";
import { Stream, StreamType } from "../common/types";

export interface StreamAbiResult {
  amount: BigNumberEvm;
  amount_per_period: BigNumberEvm;
  canceled_at: BigNumberEvm;
  cliff_amount: BigNumberEvm;
  closed: boolean;
  created: BigNumberEvm;
  current_pause_start: BigNumberEvm;
  end: BigNumberEvm;
  fees: {
    streamflow_fee_percentage: BigNumberEvm;
    streamflow_fee: BigNumberEvm;
    streamflow_fee_withdrawn: BigNumberEvm;
    partner_fee_percentage: BigNumberEvm;
    partner_fee: BigNumberEvm;
    partner_fee_withdrawn: BigNumberEvm;
    tx_fee: BigNumberEvm;
  };
  funds_unlocked_at_last_rate_change: BigNumberEvm;
  last_rate_change_time: BigNumberEvm;
  last_withdrawn_at: BigNumberEvm;
  meta: {
    automatic_withdrawal: boolean;
    can_topup: boolean;
    can_update_rate: boolean;
    cancelable_by_recipient: boolean;
    cancelable_by_sender: boolean;
    contract_name: string;
    pausable: boolean;
    transferable_by_recipient: boolean;
    transferable_by_sender: boolean;
    withdrawal_frequency: BigNumberEvm;
  };
  pause_cumulative: BigNumberEvm;
  period: BigNumberEvm;
  recipient: string;
  sender: string;
  partner: string;
  start: BigNumberEvm;
  token: string;
  withdrawn: BigNumberEvm;
}

export interface FeesAbiResult {
  exists: boolean;
  streamflow_fee: BigNumberEvm;
  partner_fee: BigNumberEvm;
}

export class EvmContract implements Stream {
  magic: number;

  version: number;

  createdAt: number;

  withdrawnAmount: BigNumber;

  canceledAt: number;

  end: number;

  lastWithdrawnAt: number;

  sender: string;

  senderTokens: string;

  recipient: string;

  recipientTokens: string;

  mint: string;

  escrowTokens: string;

  streamflowTreasury: string;

  streamflowTreasuryTokens: string;

  streamflowFeeTotal: BigNumber;

  streamflowFeeWithdrawn: BigNumber;

  streamflowFeePercent: number;

  partnerFeeTotal: BigNumber;

  partnerFeeWithdrawn: BigNumber;

  partnerFeePercent: number;

  partner: string;

  partnerTokens: string;

  start: number;

  depositedAmount: BigNumber;

  period: number;

  amountPerPeriod: BigNumber;

  cliff: number;

  cliffAmount: BigNumber;

  cancelableBySender: boolean;

  cancelableByRecipient: boolean;

  automaticWithdrawal: boolean;

  transferableBySender: boolean;

  transferableByRecipient: boolean;

  canTopup: boolean;

  name: string;

  withdrawalFrequency: number;

  closed: boolean;

  currentPauseStart: number;

  pauseCumulative: BigNumber;

  lastRateChangeTime: number;

  fundsUnlockedAtLastRateChange: BigNumber;

  type: StreamType;

  constructor(stream: StreamAbiResult) {
    this.magic = 0;
    this.version = 0;
    this.createdAt = stream.created.toNumber();
    this.withdrawnAmount = BigNumber(stream.withdrawn.toString());
    this.canceledAt = stream.canceled_at.toNumber();
    this.end = stream.end.toNumber();
    this.lastWithdrawnAt = stream.last_withdrawn_at.toNumber();
    this.sender = stream.sender;
    this.senderTokens = stream.sender;
    this.recipient = stream.recipient;
    this.recipientTokens = stream.recipient;
    this.mint = stream.token.toLowerCase();
    this.escrowTokens = "";
    this.streamflowTreasury = "";
    this.streamflowTreasuryTokens = "";
    this.streamflowFeeTotal = BigNumber(stream.fees.streamflow_fee.toString());
    this.streamflowFeeWithdrawn = BigNumber(stream.fees.streamflow_fee_withdrawn.toString());
    this.streamflowFeePercent = stream.fees.streamflow_fee_percentage.toNumber() / 10000;
    this.partnerFeeTotal = BigNumber(0);
    this.partnerFeeWithdrawn = BigNumber(0);
    this.partnerFeePercent = 0;
    this.partner = "";
    this.partnerTokens = "";
    this.start = stream.start.toNumber();
    this.depositedAmount = BigNumber(stream.amount.toString());
    this.period = stream.period.toNumber();
    this.amountPerPeriod = BigNumber(stream.amount_per_period.toString());
    this.cliff = stream.start.toNumber();
    this.cliffAmount = BigNumber(stream.cliff_amount.toString());
    this.cancelableBySender = stream.meta.cancelable_by_sender;
    this.cancelableByRecipient = stream.meta.cancelable_by_recipient;
    this.automaticWithdrawal = stream.meta.automatic_withdrawal;
    this.transferableBySender = stream.meta.transferable_by_sender;
    this.transferableByRecipient = stream.meta.transferable_by_recipient;
    this.canTopup = stream.meta.can_topup;
    this.name = stream.meta.contract_name;
    this.withdrawalFrequency = stream.meta.withdrawal_frequency.toNumber();
    this.closed = stream.closed;
    this.currentPauseStart = stream.current_pause_start.toNumber();
    this.pauseCumulative = BigNumber(stream.pause_cumulative.toString());
    this.lastRateChangeTime = stream.last_rate_change_time.toNumber();
    this.fundsUnlockedAtLastRateChange = BigNumber(stream.funds_unlocked_at_last_rate_change.toString());
    this.type = buildStreamType(this);
  }

  unlocked(currentTimestamp: number): BigNumber {
    return calculateUnlockedAmount({
      ...this,
      currentTimestamp,
    });
  }

  remaining(decimals: number): number {
    return this.depositedAmount
      .minus(this.withdrawnAmount)
      .div(10 ** decimals)
      .toNumber();
  }
}
