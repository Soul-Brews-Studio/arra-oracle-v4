import type { ExcludedItem } from "../api/memory";

/**
 * Grouped by `reason` because the two reasons are different KINDS of thing,
 * not two severities of the same problem: `unauthorized` is access control
 * working as intended (a peer's item outside its membership); `budget_exceeded`
 * is the one that actually costs the caller data (see CoverageBadge). Mixing
 * them into one flat list would read as "N things went wrong" when usually
 * zero did.
 */
export function ExcludedList({ excluded }: { excluded: ExcludedItem[] }) {
  if (excluded.length === 0) {
    return <p className="text-xs text-muted">Nothing excluded.</p>;
  }

  const unauthorized = excluded.filter((e) => e.reason === "unauthorized");
  const budgetExceeded = excluded.filter((e) => e.reason === "budget_exceeded");

  return (
    <div className="flex flex-col gap-3">
      {budgetExceeded.length > 0 && (
        <Group
          label={`budget exceeded (${budgetExceeded.length})`}
          hint="Authorized items that did not fit under max_items or the wire-byte cap -- this is the group that actually lowers coverage."
          items={budgetExceeded}
          color="text-[#f0a35e]"
        />
      )}
      {unauthorized.length > 0 && (
        <Group
          label={`unauthorized (${unauthorized.length})`}
          hint="Correct access control: the peer has no current membership in that item's session. Not incompleteness."
          items={unauthorized}
          color="text-muted"
        />
      )}
    </div>
  );
}

function Group({
  label,
  hint,
  items,
  color,
}: {
  label: string;
  hint: string;
  items: ExcludedItem[];
  color: string;
}) {
  return (
    <div>
      <p className={`text-[11px] font-medium uppercase tracking-wide ${color}`} title={hint}>
        {label}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {items.map((item, i) => (
          <li key={i} className="truncate font-mono text-[11px] text-muted">
            {item.session_name} · {item.public_id ?? "(no public_id)"}
          </li>
        ))}
      </ul>
    </div>
  );
}
