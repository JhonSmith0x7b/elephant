import { randomUUID } from "node:crypto";
import { getPool } from "./db";
import { LibraryError, getSource, importFetchedFeed, recordSourceFailure } from "./library";
import { previewFeed, RssError, type ParsedFeed } from "./rss";
import { SYNC_INTERVALS, type SyncResult, type SyncStatus } from "./sync-contracts";

const LEASE_MS = 5 * 60_000;
const START_BUDGET_MS = 180_000;
const FETCH_TIMEOUT_MS = 20_000;

interface SettingsRow {
  enabled: boolean;
  interval_minutes: number;
  revision: number;
  next_run_at: Date | null;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_error: string | null;
  last_result: SyncResult | null;
  worker_last_seen_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
}

function triggerIntervalMinutes(): number {
  const configured = Number(process.env.SYNC_TRIGGER_INTERVAL_MINUTES);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 1440) {
    return configured;
  }
  return process.env.VERCEL ? 1440 : 1;
}

function minIntervalMinutes(): number {
  return SYNC_INTERVALS.find((interval) => interval >= triggerIntervalMinutes())!;
}

function status(row: SettingsRow, now: Date): SyncStatus {
  return {
    enabled: row.enabled,
    intervalMinutes: Math.max(row.interval_minutes, minIntervalMinutes()),
    minIntervalMinutes: minIntervalMinutes(),
    triggerIntervalMinutes: triggerIntervalMinutes(),
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastStartedAt: row.last_started_at?.toISOString() ?? null,
    lastFinishedAt: row.last_finished_at?.toISOString() ?? null,
    lastError: row.last_error,
    lastResult: row.last_result,
    running: Boolean(row.lease_token && row.lease_expires_at && row.lease_expires_at > now),
    workerLastSeenAt: row.worker_last_seen_at?.toISOString() ?? null,
  };
}

export async function getSyncStatus(now = new Date()): Promise<SyncStatus> {
  const { rows } = await getPool().query<SettingsRow>("SELECT * FROM sync_settings WHERE id = true");
  if (!rows[0]) throw new LibraryError("SYNC_NOT_READY", "请先完成数据库初始化。", 503);
  return status(rows[0], now);
}

export async function updateSyncSettings(
  input: { enabled: boolean; intervalMinutes: number },
  now = new Date(),
): Promise<SyncStatus> {
  if (typeof input.enabled !== "boolean" || !SYNC_INTERVALS.some((value) => value === input.intervalMinutes)) {
    throw new LibraryError("INVALID_SYNC_SETTINGS", "请选择有效的同步间隔。");
  }
  if (input.intervalMinutes < minIntervalMinutes()) {
    throw new LibraryError("INVALID_SYNC_INTERVAL", `当前后台触发频率只支持至少 ${minIntervalMinutes()} 分钟的同步间隔。`);
  }
  const { rows } = await getPool().query<SettingsRow>(`
    UPDATE sync_settings SET enabled = $1, interval_minutes = $2,
      revision = revision + CASE WHEN enabled <> $1 OR interval_minutes <> $2 THEN 1 ELSE 0 END,
      next_run_at = CASE
        WHEN NOT $1 THEN NULL
        WHEN enabled <> $1 OR interval_minutes <> $2 OR next_run_at IS NULL
          THEN $3::timestamptz + $2 * interval '1 minute'
        ELSE next_run_at END
    WHERE id = true RETURNING *
  `, [input.enabled, input.intervalMinutes, now]);
  if (!rows[0]) throw new LibraryError("SYNC_NOT_READY", "请先完成数据库初始化。", 503);
  return status(rows[0], now);
}

export async function syncHeartbeat(now = new Date()): Promise<void> {
  await getPool().query("UPDATE sync_settings SET worker_last_seen_at = $1 WHERE id = true", [now]);
}

function safeFeedError(error: unknown): string {
  return error instanceof RssError ? error.message : "同步失败，请稍后重试。";
}

async function boundedFetch(fetchFeed: (url: string) => Promise<ParsedFeed>, url: string): Promise<ParsedFeed> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The production fetcher aborts its sockets after 15 seconds; this outer
    // bound also prevents a replacement fetch adapter from blocking the worker.
    return await Promise.race([
      fetchFeed(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RssError("TIMEOUT", "获取订阅超时，请稍后重试。", 504)), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export interface RunSyncOptions {
  force?: boolean;
  now?: () => Date;
  fetchFeed?: (url: string) => Promise<ParsedFeed>;
}

/** Shared by the standalone worker and HTTP triggers; never depends on a page being open. */
export async function runDueSync(options: RunSyncOptions = {}): Promise<SyncStatus> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const token = randomUUID();
  const pool = getPool();
  // A manual request says nothing about whether a background trigger is alive.
  if (!options.force) await syncHeartbeat(startedAt);
  const { rows } = await pool.query<SettingsRow>(`
    UPDATE sync_settings SET lease_token = $1, lease_expires_at = $2,
      last_started_at = $3, last_error = NULL
    WHERE id = true AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
      AND ($4 OR (enabled AND (next_run_at IS NULL OR next_run_at <= $3)))
    RETURNING *
  `, [token, new Date(startedAt.getTime() + LEASE_MS), startedAt, options.force === true]);
  const claimed = rows[0];
  if (!claimed) return getSyncStatus(now());

  const result: SyncResult = { sources: 0, succeeded: 0, failed: 0, inserted: 0, updated: 0 };
  let lastError: string | null = null;
  let leaseLost = false;
  const ownsLease = async () => {
    const active = await pool.query(
      "SELECT 1 FROM sync_settings WHERE id = true AND lease_token = $1 AND lease_expires_at > $2",
      [token, now()],
    );
    if (!active.rowCount) leaseLost = true;
    return !leaseLost;
  };
  try {
    const sources = (await pool.query<{ id: string }>(`
      SELECT id FROM sources WHERE deleted_at IS NULL ORDER BY last_fetched_at ASC NULLS FIRST, id
    `)).rows;
    result.sources = sources.length;
    let index = 0;
    const startDeadline = Date.now() + START_BUDGET_MS;
    const work = async () => {
      while (index < sources.length && Date.now() < startDeadline && !leaseLost) {
        const sourceId = sources[index++].id;
        try {
          if (!await ownsLease()) return;
          const source = await getSource(sourceId);
          if (!source) { result.sources--; continue; }
          const feed = await boundedFetch(options.fetchFeed ?? previewFeed, source.feedUrl);
          if (!await ownsLease()) return;
          // importFetchedFeed rechecks deleted_at under the import transaction
          // lock, so deleting a subscription during fetch cannot restore it.
          const imported = await importFetchedFeed(sourceId, feed);
          result.succeeded++;
          result.inserted += imported.insertedCount;
          result.updated += imported.updatedCount;
        } catch (error) {
          if (!await ownsLease()) return;
          if (error instanceof LibraryError && error.code === "SOURCE_NOT_FOUND") {
            result.sources--;
            continue;
          }
          result.failed++;
          try { await recordSourceFailure(sourceId, safeFeedError(error)); }
          catch { lastError = "部分来源同步失败，且未能保存来源状态，请检查数据库连接。"; }
        }
      }
    };
    await Promise.all([work(), work()]);
    if (index < sources.length && !leaseLost) {
      const deferred = sources.length - index;
      result.failed += deferred;
      lastError = `本轮达到运行时限，${deferred} 个来源留待下次同步。`;
    }
    if (result.failed && !lastError) lastError = `${result.failed} 个来源同步失败，可在来源列表查看原因。`;
  } catch {
    lastError = "本轮同步未完成，请检查数据库连接后重试。";
  } finally {
    const finishedAt = now();
    const intervalMs = Math.max(claimed.interval_minutes, minIntervalMinutes()) * 60_000;
    // Scheduled runs retain their cadence even if the trigger arrives late.
    // Anchoring to completion can make the next day's earlier cron tick skip
    // an entire day. Advance past missed slots instead of replaying them.
    const scheduleBase = !options.force && claimed.next_run_at ? claimed.next_run_at : finishedAt;
    const steps = Math.max(1, Math.floor((finishedAt.getTime() - scheduleBase.getTime()) / intervalMs) + 1);
    const nextRunAt = new Date(scheduleBase.getTime() + steps * intervalMs);
    // A crashed worker's lease expires. A recovered run owns a new token, so a
    // delayed old run cannot overwrite its result or newer settings.
    await pool.query(`
      UPDATE sync_settings SET lease_token = NULL, lease_expires_at = NULL,
        last_finished_at = $2, last_error = $3, last_result = $4::jsonb,
        next_run_at = CASE
          WHEN NOT enabled THEN NULL
          WHEN revision = $5 THEN $6::timestamptz
          ELSE next_run_at END
      WHERE id = true AND lease_token = $1 AND lease_expires_at > $2
    `, [token, finishedAt, lastError, JSON.stringify(result), claimed.revision, nextRunAt]);
  }
  return getSyncStatus(now());
}
