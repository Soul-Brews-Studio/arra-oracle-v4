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

export const DATA_DIR = process.env.ARRA_DATA_DIR ?? "../data";
export const isRemote = DATA_DIR.startsWith("s3://");

export function storageOptions(): Record<string, string> | undefined {
  if (!isRemote) return undefined;

  const account = process.env.R2_ACCOUNT_ID;
  const endpoint =
    process.env.S3_ENDPOINT ??
    (account ? `https://${account}.r2.cloudflarestorage.com` : undefined);
  const key = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;

  // Fail here, loudly, rather than let LanceDB retry an unauthenticated
  // request and surface it later as a confusing 400 from the object store.
  const missing = [
    !endpoint && "S3_ENDPOINT or R2_ACCOUNT_ID",
    !key && "AWS_ACCESS_KEY_ID",
    !secret && "AWS_SECRET_ACCESS_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`${DATA_DIR} needs ${missing.join(", ")} — see ~/.config/arra-oracle-v4/r2.env`);
  }

  return {
    endpoint: endpoint!,
    region: process.env.S3_REGION ?? "auto", // R2 ignores it; the client demands one
    access_key_id: key!,
    secret_access_key: secret!,
    // Only for a local http S3 (moto, MinIO). R2 is https and must stay so.
    allow_http: String(endpoint!.startsWith("http://")),
  };
}
