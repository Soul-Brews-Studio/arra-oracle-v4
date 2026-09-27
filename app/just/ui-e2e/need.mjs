// A later step's read of something an earlier step produced. A missing value
// throws a plain "missing" error, so a failure cascades as visible STEP_FAILs
// instead of being skipped over.
export function need(ctx, key) {
  if (ctx[key] === undefined || ctx[key] === null) throw new Error(`missing ${key} (an earlier step failed)`);
  return ctx[key];
}
