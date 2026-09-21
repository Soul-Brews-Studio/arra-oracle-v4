import { useState } from "react";

/** Shared by PeerRail and SessionRail. No trimming: `memory.ts` notes
 *  `public_id`/names are byte-exact server-side, so silently trimming
 *  whitespace here would let this form save a bookmark that never matches
 *  what the server has. Empty (post no-trim) submits are simply refused. */
export function AddNameForm({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (value === "") return;
    onSubmit(value);
    setValue("");
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
      />
      <button
        onClick={submit}
        disabled={value === ""}
        className="shrink-0 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
      >
        add
      </button>
    </div>
  );
}
