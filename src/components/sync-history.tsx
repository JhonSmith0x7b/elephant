"use client";

import { useEffect, useState } from "react";
import type { SyncRun } from "@/lib/sync-contracts";

const statusLabels = {
  success: "全部成功", partial: "部分成功", failed: "失败", running: "进行中", interrupted: "已中断", skipped: "已跳过",
};

const errorLabels: Record<string, string> = {
  DAMAGED_TEXT: "上游含乱码，已保留正常版本", LEASE_EXPIRED: "运行中断，等待下一轮同步",
  TIME_BUDGET: "本轮达到时限，留待下次同步", SYNC_ERROR: "同步未完成",
  SOURCE_CHANGED: "来源地址已修改", SOURCE_NOT_FOUND: "来源已删除",
  INVALID_URL: "订阅地址无效", UNSAFE_URL: "订阅地址未获允许", DNS_ERROR: "无法解析来源地址",
  TIMEOUT: "获取订阅超时", NETWORK_ERROR: "无法连接来源", HTTP_ERROR: "来源返回错误响应",
  TOO_MANY_REDIRECTS: "来源重定向次数过多", TOO_LARGE: "订阅内容超过大小限制",
  ACCESS_CHALLENGE: "来源要求访问验证", INVALID_XML: "订阅内容无法解析", NOT_A_FEED: "返回内容不是订阅源",
};

function errorLabel(code: string) { return errorLabels[code] ?? "处理未完成"; }

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function durationLabel(value: number | null) {
  return value === null ? "—" : `${(value / 1000).toFixed(1)} 秒`;
}

export default function SyncHistory({ lastFinishedAt }: { lastFinishedAt: string | null }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setLoading(true);
    setError("");
    void fetch("/api/sync/history", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("无法读取同步记录，请重试。");
        const data: { runs: SyncRun[] } = await response.json();
        if (active) setRuns(data.runs);
      })
      .catch(() => { if (active) setError("无法读取同步记录，请重试。"); })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [open, lastFinishedAt, refresh]);

  return <details className="sync-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>最近同步记录<span>保留 30 天 · 显示最近 20 轮</span></summary>
    <div className="sync-history-content">
      <div className="sync-history-tools"><p>时间为北京时间；“处理已有”不代表正文发生变化。</p>
        <button type="button" className="text-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? "读取中…" : "刷新记录"}</button>
      </div>
      {error && <p className="sync-error" role="alert">{error}</p>}
      {!loading && !error && runs.length === 0 && <p className="sync-history-empty">暂无记录，新同步完成后会显示在这里。</p>}
      {runs.map(run => <details className="sync-history-run" key={run.id}>
        <summary><time dateTime={run.startedAt}>{timeLabel(run.startedAt)}</time>
          <span className={`sync-history-status sync-history-status-${run.status}`}>{statusLabels[run.status]}</span>
          <span className="sync-history-counts">新增 {run.result.inserted} · 跳过 {run.result.skippedItems ?? 0}</span>
          <span className="sync-history-duration">{durationLabel(run.durationMs)}</span>
        </summary>
        <p className="sync-history-overview">{run.result.sources} 个来源；失败 {run.result.failed} 个，有跳过条目的来源 {run.result.warningSources ?? 0} 个；处理已有 {run.result.updated} 篇。</p>
        {run.errorCode && <p className="sync-warning">{errorLabel(run.errorCode)}。以下为已记录的处理结果。</p>}
        <ul className="sync-history-sources">{run.sources.map(source => <li key={source.sourceId}>
          <div><strong>{source.sourceName ?? "已删除来源"}</strong><span className={`sync-history-status sync-history-status-${source.status}`}>{source.status === "success" ? "成功" : statusLabels[source.status]}</span></div>
          <p>新增 {source.inserted} · 处理已有 {source.updated} · 跳过 {source.skippedItems} · {durationLabel(source.durationMs)}{source.errorCode && <span> · {errorLabel(source.errorCode)}</span>}</p>
        </li>)}</ul>
      </details>)}
    </div>
  </details>;
}
