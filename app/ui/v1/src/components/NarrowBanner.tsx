/** Project rule: never hide content on small screens -- warn instead.
 *  The layout stays two-pane; this just says why it will feel cramped. */
export function NarrowBanner() {
  return (
    <div className="bg-amber-500/10 px-4 py-2 text-center text-[11px] text-amber-200 lg:hidden">
      This explorer is built for a wide window — everything still works here, it will just be tight.
    </div>
  );
}
