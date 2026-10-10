import assert from "node:assert/strict";
import test from "node:test";
import { parseReadingPositions } from "../src/lib/reading-position";

test("reading positions ignore malformed storage and invalid entries", () => {
  for (const raw of [null, "oops", "null", "[]", "true"]) assert.deepEqual(parseReadingPositions(raw), {});
  assert.deepEqual(parseReadingPositions(JSON.stringify({
    valid: { articleId: "article-1", title: "标题", savedAt: 100 },
    missing: { title: "标题", savedAt: 100 },
    empty: { articleId: "", title: "标题", savedAt: 100 },
    invalidDate: { articleId: "article-2", title: "标题", savedAt: null },
    array: [],
  })), { valid: { articleId: "article-1", title: "标题", savedAt: 100 } });
});

test("reading positions keep the 60 most recent independent scopes", () => {
  const positions = parseReadingPositions(JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [
    `scope-${i}`, { articleId: `article-${i}`, title: `Title ${i}`, savedAt: i },
  ]))));
  assert.equal(Object.keys(positions).length, 60);
  assert.equal(positions["scope-0"], undefined);
  assert.equal(positions["scope-4"], undefined);
  assert.equal(positions["scope-5"].articleId, "article-5");
  assert.equal(positions["scope-64"].articleId, "article-64");
});
