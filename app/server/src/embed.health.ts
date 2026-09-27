import { DIMS, MODEL, OLLAMA_URL } from "./embed.embed";
import { embedOne } from "./embed.embedOne";

export type EmbedHealth = { ok: boolean; model: string; dims: number; detail: string };

export async function health(): Promise<EmbedHealth> {
  try {
    const v = await embedOne("health");
    return { ok: true, model: MODEL, dims: v.length, detail: `${OLLAMA_URL} responding` };
  } catch (e) {
    return { ok: false, model: MODEL, dims: DIMS, detail: String(e instanceof Error ? e.message : e) };
  }
}
