export const SYNC_INTERVALS = [15, 30, 60, 120, 360, 720, 1440] as const;

export interface SyncResult {
  sources: number;
  succeeded: number;
  failed: number;
  inserted: number;
  updated: number;
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
