import { type Bank } from "./memory";
import { call } from "./memory.call";

export const answerChat = (
  b: Bank,
  peer_name: string,
  session_name: string,
  question: string,
  max_items = 20,
) => call(b, "answerChat", { peer_name, session_name, question, max_items });
