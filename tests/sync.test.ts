import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { migrateSyncSettings } from "../scripts/migrate-sync-settings";
import { startSyncWorker } from "../scripts/sync-worker";
import { getPool } from "../src/lib/db";
import { confirmImport, createPreview, deleteSource, getSource, listLibrary } from "../src/lib/library";
import { getSyncStatus, runDueSync, updateSyncSettings } from "../src/lib/sync";
import { RssError, type ParsedFeed } from "../src/lib/rss";
import { GET, PUT } from "../src/app/api/sync/route";
import { POST } from "../src/app/api/sync/run/route";
import { GET as cron } from "../src/app/api/cron/sync/route";

const originalEnv = { ...process.env };
const schemaName = `rss_sync_test_${randomUUID().replaceAll("-", "")}`;
const epoch = new Date("2030-01-01T00:00:00Z");
const later = (minutes: number) => new Date(epoch.getTime() + minutes * 60_000);

function feed(url: string, withArticle = true): ParsedFeed {
  return {
    url, title: "Sync fixture", siteUrl: "https://example.com", language: "en", description: null,
    items: withArticle ? [{
      externalId: `${url}/one`, idKind: "guid", url: `${url}/one`, title: "Saved by background sync",
      content: "Stored source content.", contentKind: "rss_content", summary: "Short description.",
      author: null, imageUrl: null, publishedAt: null, updatedAt: null,
    }] : [],
  };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe("periodic RSS sync in an isolated PostgreSQL schema", { skip: !originalEnv.DATABASE_URL }, () => {
  let admin: Pool;
  before(async () => {
    admin = new Pool({ connectionString: originalEnv.DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const url = new URL(originalEnv.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = url.toString();
    await migrate(getPool());
  });
  beforeEach(async () => {
    delete process.env.VERCEL;
    delete process.env.SYNC_TRIGGER_INTERVAL_MINUTES;
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.LOCAL_DEV_AUTH_BYPASS = "1";
    await getPool().query("TRUNCATE sources, preview_records, sync_settings CASCADE");
    const client = await getPool().connect();
    try { await migrateSyncSettings(client); } finally { client.release(); }
  });
  after(async () => {
    await getPool().end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env = originalEnv;
  });

  async function source() {
    const url = `https://example.com/${randomUUID()}/feed`;
    return { ...await confirmImport(await createPreview(feed(url, false)), "Sync source", "literature"), url };
  }

  it("persists settings without fetching on enable; disabled and not-yet-due ticks only record a heartbeat", async () => {
    const initial = await getSyncStatus(epoch);
    assert.equal(initial.enabled, false);
    assert.equal(initial.intervalMinutes, 60);
    assert.equal(initial.triggerIntervalMinutes, 1);
    assert.equal(initial.minIntervalMinutes, 15);
    assert.equal(initial.nextRunAt, null);
    assert.equal(initial.running, false);
    await source();
    let fetched = 0;
    const fetchFeed = async (url: string) => { fetched++; return feed(url); };
    const disabled = await runDueSync({ now: () => epoch, fetchFeed });
    assert.equal(disabled.workerLastSeenAt, epoch.toISOString());
    assert.equal(fetched, 0);
    const enabled = await updateSyncSettings({ enabled: true, intervalMinutes: 60 }, epoch);
    assert.equal(enabled.nextRunAt, later(60).toISOString());
    assert.equal((await getSyncStatus(epoch)).enabled, true);
    await runDueSync({ now: () => later(59), fetchFeed });
    assert.equal(fetched, 0);
    assert.equal((await updateSyncSettings({ enabled: true, intervalMinutes: 60 }, later(10))).nextRunAt, later(60).toISOString());
    const due = await runDueSync({ now: () => later(60), fetchFeed });
    assert.equal(fetched, 1);
    assert.deepEqual(due.lastResult, { sources: 1, succeeded: 1, failed: 0, inserted: 1, updated: 0 });
    assert.equal(due.nextRunAt, later(120).toISOString());
    assert.equal((await listLibrary()).counts.articles, 1);
    await runDueSync({ now: () => later(60), fetchFeed });
    assert.equal(fetched, 1);
    const off = await updateSyncSettings({ enabled: false, intervalMinutes: 60 }, later(61));
    assert.equal(off.nextRunAt, null);
  });

  it("validates configured frequency and exposes the actual deployment trigger minimum", async () => {
    for (const intervalMinutes of [0, 1, 45, 60.5, 10080]) {
      await assert.rejects(updateSyncSettings({ enabled: true, intervalMinutes }, epoch));
    }
    await assert.rejects(updateSyncSettings({ enabled: "yes" as unknown as boolean, intervalMinutes: 60 }, epoch));
    process.env.VERCEL = "1";
    const daily = await getSyncStatus(epoch);
    assert.equal(daily.minIntervalMinutes, 1440);
    assert.equal(daily.triggerIntervalMinutes, 1440);
    assert.equal(daily.intervalMinutes, 1440);
    await assert.rejects(updateSyncSettings({ enabled: true, intervalMinutes: 60 }, epoch));
    const enabled = await updateSyncSettings({ enabled: true, intervalMinutes: 1440 }, epoch);
    assert.equal(enabled.nextRunAt, later(1440).toISOString());
    process.env.SYNC_TRIGGER_INTERVAL_MINUTES = "30";
    assert.equal((await getSyncStatus(epoch)).minIntervalMinutes, 30);
    assert.equal((await getSyncStatus(epoch)).triggerIntervalMinutes, 30);
    assert.equal((await updateSyncSettings({ enabled: true, intervalMinutes: 30 }, epoch)).intervalMinutes, 30);
    process.env.SYNC_TRIGGER_INTERVAL_MINUTES = "5";
    assert.equal((await getSyncStatus(epoch)).triggerIntervalMinutes, 5);
    assert.equal((await getSyncStatus(epoch)).minIntervalMinutes, 15);
    process.env.SYNC_TRIGGER_INTERVAL_MINUTES = "invalid";
    assert.equal((await getSyncStatus(epoch)).triggerIntervalMinutes, 1440);
  });

  it("does not manufacture or refresh a background heartbeat from a manual run", async () => {
    const manual = await runDueSync({ force: true, now: () => epoch });
    assert.equal(manual.workerLastSeenAt, null);
    assert.ok(manual.lastFinishedAt);
    const tick = await runDueSync({ now: () => later(1) });
    assert.equal(tick.workerLastSeenAt, later(1).toISOString());
    const anotherManual = await runDueSync({ force: true, now: () => later(10) });
    assert.equal(anotherManual.workerLastSeenAt, later(1).toISOString());
    assert.equal(anotherManual.lastFinishedAt, later(10).toISOString());
  });

  it("anchors periodic runs to their due time so cron jitter does not skip the next day", async () => {
    await source();
    await updateSyncSettings({ enabled: true, intervalMinutes: 1440 }, epoch);
    let clock = later(1495);
    let fetched = 0;
    const fetchFeed = async (url: string) => {
      fetched++;
      clock = new Date(clock.getTime() + 60_000);
      return feed(url);
    };
    const late = await runDueSync({ now: () => clock, fetchFeed });
    assert.equal(late.lastFinishedAt, later(1496).toISOString());
    assert.equal(late.nextRunAt, later(2880).toISOString());
    clock = later(2885);
    const earlierNextDay = await runDueSync({ now: () => clock, fetchFeed });
    assert.equal(fetched, 2);
    assert.equal(earlierNextDay.nextRunAt, later(4320).toISOString());

    clock = later(7201);
    const missedDays = await runDueSync({ now: () => clock, fetchFeed });
    assert.equal(fetched, 3);
    assert.equal(missedDays.nextRunAt, later(8640).toISOString());

    clock = later(7210);
    const manual = await runDueSync({ force: true, now: () => clock, fetchFeed });
    assert.equal(manual.nextRunAt, later(8651).toISOString());
  });

  it("atomically claims one run across concurrent manual and periodic triggers", async () => {
    await source();
    const entered = gate();
    const finish = gate();
    let fetched = 0;
    const fetchFeed = async (url: string) => { fetched++; entered.release(); await finish.wait; return feed(url); };
    const first = runDueSync({ force: true, now: () => epoch, fetchFeed });
    await entered.wait;
    const second = await runDueSync({ force: true, now: () => epoch, fetchFeed });
    assert.equal(second.running, true);
    assert.equal(fetched, 1);
    finish.release();
    const done = await first;
    assert.equal(done.running, false);
    assert.equal(done.nextRunAt, null);
    assert.equal(done.lastResult?.inserted, 1);
    const repeat = await runDueSync({ force: true, now: () => later(1), fetchFeed: async (url) => feed(url) });
    assert.equal(repeat.lastResult?.inserted, 0);
    assert.equal((await listLibrary()).counts.articles, 1);
  });

  it("isolates source failures and never imports a source deleted during its fetch", async () => {
    const healthy = await source();
    const broken = await source();
    const removed = await source();
    const gone = await source();
    await deleteSource(gone.sourceId);
    const requested: string[] = [];
    const status = await runDueSync({ force: true, now: () => epoch, fetchFeed: async (url) => {
      requested.push(url);
      if (url === broken.url) throw new RssError("HTTP_ERROR", "订阅网站返回 HTTP 503，暂时无法读取。", 502);
      if (url === removed.url) await deleteSource(removed.sourceId);
      return feed(url);
    } });
    assert.ok(!requested.includes(gone.url));
    assert.deepEqual(status.lastResult, { sources: 2, succeeded: 1, failed: 1, inserted: 1, updated: 0 });
    assert.match(status.lastError!, /1 个来源/);
    assert.match((await getSource(broken.sourceId))!.lastError!, /503/);
    assert.equal((await getSource(healthy.sourceId))!.lastError, null);
    assert.equal((await listLibrary()).counts.articles, 1);
  });

  it("recovers expired leases without allowing an old worker to overwrite the recovered result", async () => {
    await source();
    const entered = gate();
    const finish = gate();
    let clock = epoch;
    const first = runDueSync({ force: true, now: () => clock, fetchFeed: async (url) => {
      entered.release(); await finish.wait; return { ...feed(url), items: feed(url).items.map((item) => ({ ...item, title: "Stale worker" })) };
    } });
    await entered.wait;
    clock = later(6);
    const recovered = await runDueSync({ force: true, now: () => clock, fetchFeed: async (url) => feed(url) });
    assert.equal(recovered.lastResult?.inserted, 1);
    finish.release();
    await first;
    assert.deepEqual(await getSyncStatus(clock), recovered);
    assert.equal((await listLibrary()).articles[0].title, "Saved by background sync");
  });

  it("keeps interval changes and disabling made during a run", async () => {
    await source();
    await updateSyncSettings({ enabled: true, intervalMinutes: 60 }, epoch);
    const updated = await runDueSync({ force: true, now: () => later(20), fetchFeed: async (url) => {
      await updateSyncSettings({ enabled: true, intervalMinutes: 30 }, later(10));
      return feed(url);
    } });
    assert.equal(updated.intervalMinutes, 30);
    assert.equal(updated.nextRunAt, later(40).toISOString());
    const disabled = await runDueSync({ force: true, now: () => later(30), fetchFeed: async (url) => {
      await updateSyncSettings({ enabled: false, intervalMinutes: 30 }, later(25));
      return feed(url);
    } });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
    assert.equal(disabled.lastResult?.succeeded, 1);
  });

  it("can run a due background worker with no page request, and stops cleanly on shutdown", async () => {
    // An empty subscription list exercises the real worker without network I/O.
    await updateSyncSettings({ enabled: true, intervalMinutes: 15 }, new Date(0));
    const controller = new AbortController();
    const worker = startSyncWorker(controller.signal);
    for (let i = 0; i < 100; i++) {
      if ((await getSyncStatus()).lastFinishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await worker;
    const done = await getSyncStatus();
    assert.ok(done.lastStartedAt);
    assert.ok(done.lastFinishedAt);
    assert.equal(done.running, false);
    assert.deepEqual(done.lastResult, { sources: 0, succeeded: 0, failed: 0, inserted: 0, updated: 0 });
  });

  it("protects settings/manual routes with owner authorization and same-origin checks", async () => {
    const url = "http://127.0.0.1:3000/api/sync";
    const body = JSON.stringify({ enabled: true, intervalMinutes: 60 });
    const foreign = { "content-type": "application/json", origin: "https://foreign.example" };
    assert.equal((await PUT(new Request(url, { method: "PUT", headers: foreign, body }))).status, 403);
    assert.equal((await POST(new Request(`${url}/run`, { method: "POST", headers: foreign }))).status, 403);
    assert.equal((await getSyncStatus()).enabled, false);
    const ok = await PUT(new Request(url, { method: "PUT", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" }, body }));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal((await ok.json()).enabled, true);
    const current = await GET(new Request(url));
    assert.equal(current.status, 200);
    assert.equal((await current.json()).intervalMinutes, 60);
    process.env.LOCAL_DEV_AUTH_BYPASS = "0";
    delete process.env.ADMIN_EMAIL;
    assert.equal((await GET(new Request(url))).status, 503);
  });

  it("fails closed without a cron secret, rejects invalid bearer tokens and runs only when authorized", async () => {
    const url = "https://reader.example/api/cron/sync";
    assert.equal((await cron(new Request(url))).status, 503);
    process.env.CRON_SECRET = "isolated-sync-test-secret";
    assert.equal((await cron(new Request(url))).status, 401);
    assert.equal((await cron(new Request(url, { headers: { authorization: "Bearer wrong" } }))).status, 401);
    assert.equal((await getSyncStatus()).workerLastSeenAt, null);
    await updateSyncSettings({ enabled: true, intervalMinutes: 60 }, new Date(0));
    const response = await cron(new Request(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const { status } = await response.json();
    assert.equal(status.running, false);
    assert.equal(status.lastResult.sources, 0);
    assert.ok(status.lastFinishedAt);
  });
});
