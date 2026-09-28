// Shared by calls.recent.ts and calls.aggregate.ts.
export function requiredBank(bank: string | undefined): string {
  if (!bank?.trim()) throw new Error("bank is required");
  return bank;
}
