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
    INSERT INTO sync_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  `);
}
