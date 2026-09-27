import { embed, MODEL } from "./embed.embed";

export async function embedOne(text: string, model: string = MODEL): Promise<number[]> {
  return (await embed([text], model))[0]!;
}
