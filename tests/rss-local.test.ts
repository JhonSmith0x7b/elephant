import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchFeedXml, resolvePublicTarget, validateFeedUrl } from "../src/lib/rss/fetch";
import { RssError } from "../src/lib/rss/types";

let original: NodeJS.ProcessEnv;
beforeEach(() => {
  original = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "development" });
  delete process.env.VERCEL;
  process.env.RSS_LOCAL_FEED_HOSTS = "localhost,127.0.0.1,::1,reader.local,192.168.1.2";
});
afterEach(() => { process.env = original; });
const unsafe = (error: unknown) => error instanceof RssError && error.code === "UNSAFE_URL";

test("local feeds require an explicit host in development or self-hosted production", () => {
  for (const url of ["http://localhost:8000/feed", "http://127.0.0.1/feed", "http://[::1]/feed", "http://192.168.1.2/feed"]) {
    assert.equal(validateFeedUrl(url).href, url);
  }
  for (const url of ["http://127.0.0.2/feed", "http://192.168.1.3/feed", "http://other.local/feed"]) {
    assert.throws(() => validateFeedUrl(url), unsafe);
  }
  Object.assign(process.env, { NODE_ENV: "production" });
  assert.equal(validateFeedUrl("http://localhost/feed").hostname, "localhost");
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.VERCEL = "1";
  assert.throws(() => validateFeedUrl("http://localhost/feed"), unsafe);
  delete process.env.VERCEL;
  delete process.env.RSS_LOCAL_FEED_HOSTS;
  assert.throws(() => validateFeedUrl("http://localhost/feed"), unsafe);
});

test("allowlisted DNS names may resolve privately but unrelated domains and metadata remain blocked", async () => {
  const privateDns = async () => [{ address: "192.168.1.9", family: 4 }];
  assert.equal((await resolvePublicTarget("http://reader.local/feed", privateDns)).address, "192.168.1.9");
  await assert.rejects(resolvePublicTarget("https://example.com/feed", privateDns), unsafe);
  await assert.rejects(resolvePublicTarget("http://reader.local/feed", async () => [
    { address: "192.168.1.9", family: 4 }, { address: "169.254.169.254", family: 4 },
  ]), unsafe);
  process.env.RSS_LOCAL_FEED_HOSTS += ",169.254.169.254,100.100.100.200,224.0.0.1";
  for (const host of ["169.254.169.254", "100.100.100.200", "224.0.0.1"]) {
    assert.throws(() => validateFeedUrl(`http://${host}/feed`), unsafe);
  }
});

test("local HTTP fetch uses system DNS even in cloudflare mode and rechecks redirects", async () => {
  process.env.RSS_DNS_MODE = "cloudflare";
  const xml = "<rss><channel><title>本机测试</title></channel></rss>";
  const server = createServer((req, res) => {
    if (req.url === "/blocked") { res.writeHead(302, { Location: "http://127.0.0.2/feed" }); res.end(); }
    else if (req.url === "/redirect") { res.writeHead(302, { Location: "/feed" }); res.end(); }
    else { res.setHeader("Content-Type", "application/rss+xml; charset=utf-8"); res.end(xml); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const result = await fetchFeedXml(`http://localhost:${port}/redirect`);
    assert.equal(result.xml, xml);
    assert.equal(result.url, `http://localhost:${port}/feed`);
    await assert.rejects(fetchFeedXml(`http://localhost:${port}/blocked`), unsafe);
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("production allowlist permits only the configured RSS container", async () => {
  Object.assign(process.env, { NODE_ENV: "production", RSS_LOCAL_FEED_HOSTS: "any2rss-web-1" });
  const resolve = async () => [{address:"172.23.0.2", family:4}];
  assert.equal((await resolvePublicTarget("http://any2rss-web-1:8000/feed", resolve)).address, "172.23.0.2");
  await assert.rejects(resolvePublicTarget("http://other-service/feed", resolve), unsafe);
  await assert.rejects(resolvePublicTarget("http://any2rss-web-1/feed", async () => [{address:"169.254.169.254", family:4}]), unsafe);
  assert.throws(() => validateFeedUrl("http://172.23.0.2/feed"), unsafe);
});

test("production allowlist fetches local feeds and rejects redirects to metadata", async () => {
  Object.assign(process.env, { NODE_ENV: "production", RSS_LOCAL_FEED_HOSTS: "127.0.0.1", RSS_DNS_MODE: "cloudflare" });
  const server = createServer((req, res) => {
    if (req.url === "/blocked") res.writeHead(302, {Location:"http://169.254.169.254/latest/meta-data"}).end();
    else if (req.url === "/redirect") res.writeHead(302, {Location:"/feed"}).end();
    else res.end("<rss><channel><title>Internal</title></channel></rss>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    assert.match((await fetchFeedXml(`${base}/redirect`)).xml, /Internal/);
    await assert.rejects(fetchFeedXml(`${base}/blocked`), unsafe);
  } finally {server.close(); await once(server, "close");}
});


test("only allowlisted Tailscale names can resolve to CGNAT and metadata stays blocked", async () => {
  Object.assign(process.env, { NODE_ENV: "production", RSS_LOCAL_FEED_HOSTS: "jp0x01.tail409a2a.ts.net,reader.local" });
  const resolver = async () => [{address:"100.65.121.39", family:4}];
  const url = "https://jp0x01.tail409a2a.ts.net:10000/any2rss/feeds/example.xml?token=test";
  const target = await resolvePublicTarget(url, resolver);
  assert.equal(target.address, "100.65.121.39");
  assert.equal(target.url.href, url);
  for (const url of ["http://other.ts.net/feed", "http://reader.local/feed", "http://100.65.121.39/feed"]) {
    await assert.rejects(resolvePublicTarget(url, resolver), unsafe);
  }
  await assert.rejects(resolvePublicTarget(url, async () => [{address:"100.100.100.200", family:4}]), unsafe);
});
