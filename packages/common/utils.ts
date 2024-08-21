import BigNumber from "bignumber.js";

import { ContractError } from "./types.js";

/**
 * Used for conversion of token amounts to their Big Number representation.
 * Get Big Number representation in the smallest units from the same value in the highest units.
 * @param {number} value - Number of tokens you want to convert to its BigNumber representation.
 * @param {number} decimals - Number of decimals the token has.
 */
export const getBN = (value: number, decimals: number): BigNumber => {
  const decimalPart = value - Math.trunc(value);
  const integerPart = BigNumber(Math.trunc(value));

  const decimalE = BigNumber(decimalPart * 1e9);

  const sum = integerPart.times(BigNumber(1e9)).plus(decimalE);
  const resultE = sum.times(BigNumber(10).pow(BigNumber(decimals)));
  return resultE.div(BigNumber(1e9));
};

/**
 * Used for token amounts conversion from their Big Number representation to number.
 * Get value in the highest units from BigNumber representation of the same value in the smallest units.
 * @param {BigNumber} value - Big Number representation of value in the smallest units.
 * @param {number} decimals - Number of decimals the token has.
 */
export const getNumberFromBN = (value: BigNumber, decimals: number): number =>
  value.gt(BigNumber(2 ** 53 - 1))
    ? value.div(BigNumber(10 ** decimals)).toNumber()
    : value.toNumber() / 10 ** decimals;

/**
 * Used to make on chain calls to the contract and wrap raised errors if any
 * @param func function that interacts with the contract
 * @param callback callback that may be used to extract error code
 * @returns {T}
 */
export async function handleContractError<T>(
  func: () => Promise<T>,
  callback?: (err: Error) => string | null,
): Promise<T> {
  try {
    return await func();
  } catch (err: any) {
    if (err instanceof Error) {
      if (callback) {
        throw new ContractError(err, callback(err));
      }
      throw new ContractError(err);
    }
    throw err;
  }
}

/**
 * Pause async function execution for given amount of milliseconds
 * @param ms millisecond to sleep for
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
