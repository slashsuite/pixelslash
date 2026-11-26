import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

// release.sh's free-space check, run in a throwaway git repo with `ssh` and `bun` stubbed: the fake
// ssh answers `df` with the free space the test names and logs every call with the bytes it was
// sent on stdin, so a tarball streamed to the host would show. `bun` only logs, then fails, so a
// release that passes the check stops at its first build step.
const SCRIPT = fileURLToPath(new URL("./release.sh", import.meta.url));

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function release(freeKb: string, sshFails = false) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "release-sh-")));
  const repo = join(root, "repo");
  const stubs = join(root, "stubs");
  const log = join(root, "calls.log");
  mkdirSync(repo);
  mkdirSync(stubs);
  writeFileSync(log, "");
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  git("init", "-q");
  writeFileSync(join(repo, "README"), "x\n");
  git("add", "README");
  git("commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD").stdout.trim();
  const stub = (name: string, body: string) => {
    writeFileSync(join(stubs, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  };
  stub(
    "ssh",
    [
      'echo "ssh $* stdin=$(wc -c | tr -d " ")" >>"$STUB_LOG"',
      sshFails ? "exit 255" : "",
      'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
      `echo "/dev/loop0 8000000 7000000 ${freeKb} 90% /"`,
    ].join("\n"),
  );
  stub("bun", 'echo "bun $*" >>"$STUB_LOG"; exit 3');
  const result = spawnSync("bash", [SCRIPT, sha], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env["PATH"]}`,
      STUB_LOG: log,
      PIXELSLASH_LAN_SSH: "root@host.example.test",
      PIXELSLASH_LAN_CT: "135",
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

test("a CT with under 1 GiB free is refused before anything is built or sent", () => {
  const { status, stderr, calls } = release("524288");
  expect(status).toBe(1);
  expect(stderr).toContain("refusing to deploy: CT 135 has 512 MiB free under /home/pixelslash");
  expect(stderr).toContain("Nothing was built or sent");
  // One call, the df, with nothing on its stdin; no build.
  expect(calls).toEqual([
    "ssh -o BatchMode=yes root@host.example.test pct exec 135 -- df -Pk /home/pixelslash stdin=0",
  ]);
});

test("with room to spare the release goes on to build", () => {
  const { status, calls } = release(String(4 * 1024 * 1024));
  expect(status).toBe(3);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe("bun install --frozen-lockfile");
});

test("a free space it cannot read refuses too", () => {
  expect(release("lots").stderr).toContain("could not read the free space on CT 135 from df");
  const failed = release("0", true);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("could not read the free space on CT 135");
  expect(failed.calls).toHaveLength(1);
});
