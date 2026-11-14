export const SYNC_INTERVALS = [15, 30, 60, 120, 360, 720, 1440] as const;

export interface SyncResult {
  sources: number;
  succeeded: number;
  failed: number;
  inserted: number;
  /** Existing items processed, not necessarily changed. */
  updated: number;
  warningSources?: number;
  skippedItems?: number;
}

export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  minIntervalMinutes: number;
  triggerIntervalMinutes: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastResult: SyncResult | null;
  running: boolean;
  workerLastSeenAt: string | null;
}

export interface SyncSourceRun {
  sourceId: string;
  sourceName: string;
  status: "success" | "partial" | "failed" | "skipped";
  inserted: number;
  updated: number;
  skippedItems: number;
  durationMs: number;
  errorCode: string | null;
}

export interface SyncRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: "success" | "partial" | "failed" | "running" | "interrupted";
  result: SyncResult;
  sources: SyncSourceRun[];
  errorCode: string | null;
}
