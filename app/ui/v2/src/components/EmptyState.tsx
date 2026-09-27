/** Centered placeholder, no icon -- reused for "no session picked" and
 *  "session picked but empty". The caller decides which case it is; this
 *  component only lays out a title + one line of explanation. Both lines
 *  wrap anywhere: the detail is often an id or a session name, and a centred
 *  column item sizes to its min-content, so an unbroken one would overflow. */
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium text-slate-100 [overflow-wrap:anywhere]">{title}</p>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">{detail}</p>
    </div>
  );
}
