import { newPublicId } from "./memory.newPublicId";
import type { Bank } from "./memory";
import { type RetireNodeInput } from "./evidenceReview";
import { call } from "./evidenceReview.call";

export const retireNode = (b: Bank, input: RetireNodeInput) =>
  call(b, "retireNode", { ...input, operation_id: newPublicId() });
