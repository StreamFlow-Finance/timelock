import BigNumber from "bignumber.js";

export const BASE_FEE = 1009900; // Buffer to include usual fees when calculating stream amount
// this magical number needs updating probably
export const WITHDRAW_AVAILABLE_AMOUNT = BigNumber("18446744073709551615"); // Magical number to withdraw all available amount from a Contract
