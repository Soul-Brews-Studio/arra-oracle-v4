// Where the dataset lives. ONE env var decides: a path is local, an `s3://`
// URI is object storage. Everything else in the server is unaware.
//
//   ARRA_DATA_DIR=../data                          local (default)
//   ARRA_DATA_DIR=s3://arra-oracle-v4-poc/data     R2
//
// Mirrors migrate-py/src/arra_migrate/storage.py. Change both or neither.
//
// Measured against real R2 2026-09-18: create+write 2310 ms, second write
// (the manifest commit) 1155 ms, versus 11 ms / 5 ms on a local S3. The commit
// is a round trip per write, so object storage is ~200x on that path. Lance
// needs no DynamoDB for it -- conditional put has been the default since
// lance-format#2793, and R2 honours If-Match/If-None-Match.

import { storageOptionsForRoot } from "./storage.storageOptionsForRoot";

export const DATA_DIR = process.env.ARRA_DATA_DIR ?? "../data";
export const isRemote = DATA_DIR.startsWith("s3://");

export function storageOptions(): Record<string, string> | undefined {
  return storageOptionsForRoot(DATA_DIR);
}
