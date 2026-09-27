// Form ops that pick an explicit revision pair in the Knowledge view's diff
// picker ("#1" vs "#2" matches the option text `#1 — <title>`). The test
// always picks the pair by hand, as a reader would: after an in-place revise
// the picker keeps its old choice (UI-E2E.md, "Defects found").
export function diffPair(from, to) {
  return [
    { root: "diff", select: "select:nth-of-type(1)", optionText: `${from} — ` },
    { root: "diff", select: "select:nth-of-type(2)", optionText: `${to} — ` },
  ];
}
