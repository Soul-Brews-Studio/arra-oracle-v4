import { type Bank } from "./memory";
import { call } from "./memory.call";

export const getSession = (b: Bank, session_name: string) => call(b, "getSession", { session_name });
