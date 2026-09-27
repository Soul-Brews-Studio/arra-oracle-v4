// The titles, bodies and reasons the #33 chain types into the UI, in one
// place so the write steps and the later read-back compare the same bytes.
export const text = {
  a1: { title: "Dev server port — พอร์ตเซิร์ฟเวอร์", body: "The dev server listens on 47777.\nเซิร์ฟเวอร์ dev ฟังที่พอร์ต 47777" },
  a2: { title: "Dev server port — พอร์ตเซิร์ฟเวอร์ (rev 2)", body: "The dev server listens on 47777; the test server on 47778.\nเซิร์ฟเวอร์ทดสอบฟังที่พอร์ต 47778", reason: "add the test server port" },
  d: { title: "Port list draft (retired later)", body: "Scratch list of ports, cites A #2; retired before the supersede." },
  b: { title: "Port conventions: อย่าหลงลืม", body: "อย่าหลงลืมจองพอร์ตก่อนรันเทสต์ -- never forget to reserve the port before a test run." },
  c: { title: "Test server port is 47779", body: "Correction: the test server moved to 47779; revision #2 said 47778.", reason: "port moved" },
  url: "https://example.invalid/runbooks/ports",
  // Node L, the label-snapshot check: rev 1 and 2 are API writes (the UI
  // cannot attach a topic term), rev 3 is a UI revise.
  l1: { title: "Snapshot retention — การเก็บ snapshot", body: "Keep 7 daily disk snapshots.\nเก็บ snapshot ดิสก์รายวัน 7 ชุด" },
  l2: { title: "Snapshot retention (rev 2)", body: "Keep 14 daily disk snapshots.\nเก็บ snapshot ดิสก์รายวัน 14 ชุด" },
  l3: { title: "Snapshot retention (rev 3, edited in the UI)", body: "Keep 30 daily disk snapshots.", reason: "a later edit through the UI" },
};
