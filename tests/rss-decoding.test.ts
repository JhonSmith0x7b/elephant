import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFeedBody } from "../src/lib/rss/fetch";
import { RssError } from "../src/lib/rss/types";

test("Chinese titles survive every possible network chunk boundary", () => {
  const xml = "<rss><channel><item><title>日本监管机构要求金融公司审查网络安全</title></item></channel></rss>";
  const bytes = Buffer.from(xml);
  for (let split = 0; split <= bytes.length; split += 1) {
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
    assert.equal(decodeFeedBody(Buffer.concat(chunks)), xml);
  }
});

test("Invalid UTF-8 is rejected instead of silently saving replacement characters", () => {
  for (const invalid of [Buffer.from([0xe6, 0x9c]), Buffer.from([0x80]), Buffer.from([0xe6, 0x41, 0xac])]) {
    const bytes = Buffer.concat([Buffer.from("<title>日"), invalid, Buffer.from("监管机构</title>")]);
    assert.throws(() => decodeFeedBody(bytes), (error) => error instanceof RssError
      && error.code === "INVALID_XML" && error.status === 502 && /损坏/.test(error.message));
  }
});

test("Unsupported encoding is distinguished from damaged encoded bytes", () => {
  assert.throws(() => decodeFeedBody(Buffer.from("<rss/>"), "application/xml; charset=unsupported-encoding"),
    (error) => error instanceof RssError && error.code === "INVALID_XML"
      && /暂不支持/.test(error.message) && !/损坏/.test(error.message));
});

test("XML encoding still takes precedence over HTTP charset, with charset fallback supported", () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><title>日本</title>';
  assert.equal(decodeFeedBody(Buffer.from(xml), "application/xml; charset=windows-1252"), xml);
  assert.equal(decodeFeedBody(Buffer.from("<title>Café</title>", "latin1"), "text/xml; charset=windows-1252"),
    "<title>Café</title>");
});

test("Literal replacement characters are preserved for separate content validation", () => {
  const xml = "<title>日\ufffd\ufffd\ufffd监管机构</title>";
  assert.equal(decodeFeedBody(Buffer.from(xml)), xml);
});
