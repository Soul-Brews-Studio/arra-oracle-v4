import { ContractError } from "../contracts/errors";

/**
 * Re-anchor a governed error beneath this request's item pointer.
 *
 * Code and MESSAGE are carried across untouched; only the path moves. An
 * invented message here silently replaced the accepted codec's literal and no
 * assertion that checked version/code/path could see it -- the message is part
 * of the envelope.
 *
 * Same shape the codec itself uses when it re-anchors helper paths.
 */
export function reanchorContractError(error: unknown, prefix: string): never {
  if (error instanceof ContractError) {
    throw new ContractError(error.code, `${prefix}${error.path}`, error.message);
  }
  throw error;
}
