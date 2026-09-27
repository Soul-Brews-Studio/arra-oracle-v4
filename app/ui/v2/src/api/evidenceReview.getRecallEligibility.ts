import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

export const getRecallEligibility = (b: Bank, node_id: string) => call(b, "getRecallEligibility", { node_id });
