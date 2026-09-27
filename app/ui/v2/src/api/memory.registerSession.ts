import { type Bank } from "./memory";
import { call } from "./memory.call";

export const registerSession = (b: Bank, session_name: string) => call(b, "registerSession", { session_name });
