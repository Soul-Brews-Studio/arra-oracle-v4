import { target19ReaderState } from "./db.legacyRead.state";

/** Test-only: forces the next `openTarget19MemoryReader` to reopen (e.g. against a new env/dataset). */
export function resetReaderForTests(): void {
  target19ReaderState.cached = null;
}
