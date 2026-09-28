// One place that turns a root (local path or `s3://` URI) into LanceDB storage options.
// Split out of storage.storageOptions.ts (one exported function per file) so that
// `storage.opsStorageOptions.ts` (R33 S4(a)) can reuse it for `ARRA_OPS_DIR`.

export function storageOptionsForRoot(root: string): Record<string, string> | undefined {
  if (!root.startsWith("s3://")) return undefined;

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
    throw new Error(`${root} needs ${missing.join(", ")} — see ~/.config/arra-oracle-v4/r2.env`);
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
