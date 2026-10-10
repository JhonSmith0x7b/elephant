import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { resolvedTheme, themePreference, THEME_INIT_SCRIPT } from "../src/lib/theme";

function boot(saved: string | null, systemDark: boolean, storageFails = false) {
  const dataset: Record<string, string> = {};
  runInNewContext(THEME_INIT_SCRIPT, {
    localStorage: { getItem: () => { if (storageFails) throw new Error("Storage denied"); return saved; } },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: { documentElement: { dataset } },
  });
  return dataset;
}
test("first visit stays light even on a dark system; invalid or blocked storage is safe", () => {
  for (const saved of [null, "unknown"]) assert.deepEqual(boot(saved, true), {theme:"light", themePreference:"light"});
  assert.equal(boot("dark", true, true).theme, "light");
});
test("saved preferences apply before paint and system mode follows the current OS", () => {
  for (const preference of ["light", "dark", "system"] as const) {
    for (const systemDark of [true, false]) {
      assert.equal(boot(preference, systemDark).theme, resolvedTheme(preference, systemDark));
      assert.equal(boot(preference, systemDark).themePreference, preference);
    }
  }
  assert.equal(themePreference("invalid"), "light");
  assert.equal(resolvedTheme("system", true), "dark");
  assert.equal(resolvedTheme("system", false), "light");
});
