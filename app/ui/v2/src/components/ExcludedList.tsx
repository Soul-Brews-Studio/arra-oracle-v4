import type { ExcludedItem } from "../api/memory";

type BudgetItem = Extract<ExcludedItem, { reason: "budget_exceeded" }>;

/**
 * Grouped by `reason`, because the two reasons carry different information
 * (#85, overnight ruling R4). Both lower coverage, but only a budget stop
 * can be identified: `unauthorized` arrives as ONE anonymous count, since
 * listing a peer's out-of-scope items by id was itself the leak. A budget
 * entry with no public_id is the linked-session bound, which names no
 * session on purpose. `omitted` is the list's own truncation signal: budget
 * entries past its byte bound, counted rather than dropped silently.
 */
export function ExcludedList({ excluded, omitted }: { excluded: ExcludedItem[]; omitted: number }) {
  if (excluded.length === 0 && omitted === 0) {
    return <p className="text-xs text-muted">Nothing excluded.</p>;
  }

  const unauthorized = excluded.reduce((n, e) => (e.reason === "unauthorized" ? n + e.count : n), 0);
  const budgetExceeded = excluded.filter((e): e is BudgetItem => e.reason === "budget_exceeded");

  return (
    <div className="flex flex-col gap-3">
      {(budgetExceeded.length > 0 || omitted > 0) && (
        <div>
          <p
            className="text-[11px] font-medium uppercase tracking-wide text-[#f0a35e]"
            title="Authorized items that did not fit under max_items or the wire-byte cap, or linked sessions past the bound."
          >
            budget exceeded ({budgetExceeded.length + omitted})
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {budgetExceeded.map((item, i) => (
              <li key={i} className="truncate font-mono text-[11px] text-muted">
                {item.public_id === null
                  ? "linked sessions past the bound (not searched)"
                  : `${item.session_name} · ${item.public_id}`}
              </li>
            ))}
            {omitted > 0 && <li className="text-[11px] text-muted">+{omitted} more, not listed (list byte bound)</li>}
          </ul>
        </div>
      )}
      {unauthorized > 0 && (
        <p
          className="text-[11px] font-medium uppercase tracking-wide text-[#f0a35e]"
          title="Messages in linked sessions this peer is not a current member of. Withheld and deliberately not identified."
        >
          unauthorized ({unauthorized}) · not identified
        </p>
      )}
    </div>
  );
}
