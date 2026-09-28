import { realpathSync } from "node:fs";
import { failPublication } from "./errors";

// Shared by assertInheritedGate and assertLocalDatasetRoot.
export function realpathOrFail(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return failPublication("unsupported_dataset");
  }
}
