import { newPublicId, type Bank } from "./memory";
import { type SupersedeNodeInput } from "./evidenceReview";
import { call } from "./evidenceReview.call";

export const supersedeNode = (b: Bank, input: SupersedeNodeInput) =>
  call(b, "supersedeNode", { ...input, operation_id: newPublicId() });
