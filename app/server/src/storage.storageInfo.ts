import { DATA_DIR, isRemote } from "./storage.storageOptions";

/** What /health should say, with no secret in it. */
export function storageInfo() {
  return {
    uri: DATA_DIR,
    kind: isRemote ? "s3" : "local",
    endpoint: isRemote ? (process.env.S3_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`) : null,
  };
}
