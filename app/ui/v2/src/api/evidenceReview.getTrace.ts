import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

export const getTrace = (b: Bank, id: string) => call(b, "getTrace", { id });
