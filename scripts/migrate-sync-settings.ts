import type { PoolClient } from "pg";

export async function migrateSyncSettings(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      enabled boolean NOT NULL DEFAULT false,
      interval_minutes integer NOT NULL DEFAULT 60
        CHECK (interval_minutes IN (15, 30, 60, 120, 360, 720, 1440)),
      revision integer NOT NULL DEFAULT 0,
      next_run_at timestamptz,
      last_started_at timestamptz,
      last_finished_at timestamptz,
      last_error text,
      last_result jsonb,
      worker_last_seen_at timestamptz,
      lease_token uuid,
      lease_expires_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id uuid PRIMARY KEY,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      status text NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'interrupted')),
      result jsonb NOT NULL,
      source_results jsonb NOT NULL DEFAULT '[]'::jsonb,
      error_code text
    );
    CREATE INDEX IF NOT EXISTS sync_runs_started_at_idx ON sync_runs (started_at DESC);
    INSERT INTO sync_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  `);
}
