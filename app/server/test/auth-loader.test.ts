// #25 loader evidence (`authorization-integration-v1.md` §2).
//
// Real temporary files, synthetic policies, no real credential and no dataset.
// Every failure mode must collapse to the same opaque denial: a caller learning
// "malformed" vs "wrong permissions" learns about server state they cannot see.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, MAX_POLICY_BYTES } from "../src/auth/loader";
import { admit } from "../src/auth/policy";
import { bearer, defaultPolicyDocument, NOW_MS, TOKENS } from "./helpers/auth-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

let dir: string;
const policyAt = (name = "policy.json") => join(dir, name);

const write = (contents: string | Uint8Array, name = "policy.json", mode = 0o600) => {
  const path = policyAt(name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "NO_THROW";
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arra-v4-loader-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loading a valid policy", () => {
  test("a well-formed 0600 policy loads and admits its credential", () => {
    const path = write(JSON.stringify(defaultPolicyDocument()));
    const policy = loadPolicy(path);
    const admission = admit(policy, {
      authorization: bearer(TOKENS.alpha.secret),
      now_ms: NOW_MS,
      target: { kind: "workspace", workspace: "alpha", action: "content:read" },
    } as never);
    expect(admission.principal_id).toBe("operator-a");
  });

  test("every load returns a FRESH snapshot — there is no cache", () => {
    const path = write(JSON.stringify(defaultPolicyDocument()));
    const first = loadPolicy(path);
    expect(first).not.toBe(loadPolicy(path));
  });
});

describe("replacement, revocation and expiry are observed on the next load", () => {
  test("an atomic replacement revoking a credential denies the NEXT request", () => {
    const path = write(JSON.stringify(defaultPolicyDocument()));
    const before = loadPolicy(path);
    expect(() =>
      admit(before, {
        authorization: bearer(TOKENS.alpha.secret),
        now_ms: NOW_MS,
        target: { kind: "workspace", workspace: "alpha", action: "content:read" },
      } as never),
    ).not.toThrow();

    const revoked = defaultPolicyDocument();
    revoked.credentials[0]!.revoked = true;
    write(JSON.stringify(revoked));

    const after = loadPolicy(path);
    expect(
      codeOf(() =>
        admit(after, {
          authorization: bearer(TOKENS.alpha.secret),
          now_ms: NOW_MS,
          target: { kind: "workspace", workspace: "alpha", action: "content:read" },
        } as never),
      ),
    ).toBe("unauthenticated");
  });

  test("deleting the policy denies rather than serving the last good one", () => {
    const path = write(JSON.stringify(defaultPolicyDocument()));
    expect(() => loadPolicy(path)).not.toThrow();
    rmSync(path);
    expect(codeOf(() => loadPolicy(path))).toBe("policy_unavailable");
  });
});

describe("every rejection is the same opaque failure", () => {
  test("missing, malformed, non-UTF8 and schema-invalid all read as policy_unavailable", () => {
    expect(codeOf(() => loadPolicy(policyAt("absent.json")))).toBe("policy_unavailable");
    expect(codeOf(() => loadPolicy(write("{ not json", "bad.json")))).toBe("policy_unavailable");
    expect(codeOf(() => loadPolicy(write(new Uint8Array([0xff, 0xfe]), "utf8.json")))).toBe("policy_unavailable");
    expect(codeOf(() => loadPolicy(write(JSON.stringify({ version: "arra-auth/v2" }), "schema.json")))).toBe(
      "policy_unavailable",
    );
  });

  test("a relative path is refused without touching the filesystem", () => {
    expect(codeOf(() => loadPolicy("policy.json"))).toBe("policy_unavailable");
    expect(codeOf(() => loadPolicy("./policy.json"))).toBe("policy_unavailable");
  });

  test("a symlink is refused — O_NOFOLLOW, not a resolved path", () => {
    const real = write(JSON.stringify(defaultPolicyDocument()), "real.json");
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    // The TARGET is perfectly valid; only the symlink itself is refused.
    expect(() => loadPolicy(real)).not.toThrow();
    expect(codeOf(() => loadPolicy(link))).toBe("policy_unavailable");
  });

  test("a FIFO is refused PROMPTLY and never blocks waiting for a writer", async () => {
    // Regression: a read-only open of a FIFO blocks until a writer appears, so
    // the non-regular-file check could never run and the event loop hung.
    //
    // This MUST run in an owned child process with a parent-enforced timeout.
    // Timing the synchronous call in-process would be useless: if the fix
    // regressed, loadPolicy would never return, the assertion would never
    // execute, and the suite would HANG rather than fail. A hanging test
    // reports nothing.
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", ["-m", "600", fifo]);

    const probe = join(dir, "probe.ts");
    const loaderUrl = new URL("../src/auth/loader.ts", import.meta.url).pathname;
    writeFileSync(
      probe,
      `const { loadPolicy } = await import(${JSON.stringify(loaderUrl)});\n` +
        `try { loadPolicy(${JSON.stringify(fifo)}); console.log("NO_THROW"); }\n` +
        `catch (e) { console.log(e?.code ?? "NO_CODE"); }\n`,
      "utf-8",
    );

    const child = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    let stdout = "";
    try {
      const exit = await child.exited;
      clearTimeout(timer);
      stdout = (await new Response(child.stdout).text()).trim();
      // A killed child means the open blocked: that is the regression.
      expect(exit).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
    expect(stdout).toBe("policy_unavailable");
  }, testTimeout(20_000));

  test("a directory is refused", () => {
    const sub = join(dir, "adir");
    mkdirSync(sub);
    expect(codeOf(() => loadPolicy(sub))).toBe("policy_unavailable");
  });

  test("group- or other-readable permissions are refused", () => {
    const path = write(JSON.stringify(defaultPolicyDocument()), "loose.json", 0o644);
    expect(codeOf(() => loadPolicy(path))).toBe("policy_unavailable");
    chmodSync(path, 0o600);
    expect(() => loadPolicy(path)).not.toThrow();
    chmodSync(path, 0o604);
    expect(codeOf(() => loadPolicy(path))).toBe("policy_unavailable");
  });
});

describe("the size cap is enforced on the real file, at the boundary", () => {
  // The document is padded with genuine inter-token JSON whitespace so it stays
  // SCHEMA-VALID at the cap: success there is real evidence the gate admitted
  // it, rather than a rejection that happens to come from somewhere else.
  const sizedPolicy = (totalBytes: number): string => {
    const body = JSON.stringify(defaultPolicyDocument());
    const head = body.slice(0, 1);
    const tail = body.slice(1);
    const padding = totalBytes - body.length;
    if (padding < 0) throw new Error("requested size below the document size");
    return `${head}${" ".repeat(padding)}${tail}`;
  };

  test("a policy of exactly 262144 bytes loads", () => {
    const text = sizedPolicy(MAX_POLICY_BYTES);
    expect(Buffer.byteLength(text, "utf-8")).toBe(262144);
    expect(() => loadPolicy(write(text, "atcap.json"))).not.toThrow();
  });

  test("a policy of 262145 bytes is refused", () => {
    const text = sizedPolicy(MAX_POLICY_BYTES + 1);
    expect(Buffer.byteLength(text, "utf-8")).toBe(262145);
    expect(codeOf(() => loadPolicy(write(text, "overcap.json")))).toBe("policy_unavailable");
  });

  test("a far oversized policy is refused without being fully buffered as valid", () => {
    expect(codeOf(() => loadPolicy(write(sizedPolicy(MAX_POLICY_BYTES + 8192), "huge.json")))).toBe(
      "policy_unavailable",
    );
  });
});
