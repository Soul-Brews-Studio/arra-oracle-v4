/** The empty state for TermCloud. This is not a generic "nothing here yet" --
 *  it has to say WHY the cloud can never be a full picture: there is no
 *  listing endpoint over revisions (issue #88), so this client can only ever
 *  show terms from nodes it has itself published or bookmarked. A cloud that
 *  looked empty-but-complete, or later full-but-complete, would misstate its
 *  own coverage either way, so that limit is stated here even when there is
 *  nothing to show, not just as a caveat once data arrives. */
export function TermCloudEmpty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium text-slate-100">No terms to show</p>
      <p className="max-w-xs text-xs text-muted">
        This cloud only covers revisions this client has published or bookmarked in this browser.
        There is no endpoint to list every revision in the workspace, so it can never be a survey of
        the whole workspace's tags -- only of what this client happens to have seen.
      </p>
    </div>
  );
}
