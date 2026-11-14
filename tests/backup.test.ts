import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("daily backups publish validated archives and prune only after success", () => {
  const root = mkdtempSync(join(tmpdir(), "elephant-backup-"));
  try {
    const bin = join(root, "bin");
    const daily = join(root, "backups/daily");
    mkdirSync(bin); mkdirSync(daily, { recursive: true });
    // File locking is provided by Linux flock in production; this test checks
    // publication, validation failure, permissions and retention independently.
    writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(bin, "docker"), `#!/bin/sh
case "$*" in
  *pg_dump*) [ "$FAIL_DUMP" != 1 ] || exit 1; printf archive ;;
  *pg_restore*) cat >/dev/null; [ "$FAIL_VALIDATE" != 1 ] ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    const old = join(daily, "old.dump");
    const rollback = join(root, "backups/rollback.dump");
    writeFileSync(old, "old"); writeFileSync(rollback, "keep");
    const age = new Date(Date.now() - 40 * 86400_000);
    utimesSync(old, age, age); utimesSync(rollback, age, age);
    const run = (extra: Record<string, string> = {}) => spawnSync("bash", [resolve("deploy/backup.sh")], {
      env: { ...process.env, ELEPHANT_ROOT: root, PATH: `${bin}:${process.env.PATH}`, ...extra }, encoding: "utf8",
    });
    const failures: Record<string, string>[] = [{ FAIL_DUMP: "1" }, { FAIL_VALIDATE: "1" }];
    for (const failure of failures) {
      assert.notEqual(run(failure).status, 0);
      assert.deepEqual(readdirSync(daily), ["old.dump"]);
    }
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(rollback), true);
    const files = readdirSync(daily);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}Z\.dump$/);
    assert.equal(statSync(join(daily, files[0])).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
