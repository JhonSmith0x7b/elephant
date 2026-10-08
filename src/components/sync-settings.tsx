"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import type { SyncStatus } from "@/lib/sync-contracts";
import "./sync-settings.css";

const intervals = [
  [15, "每 15 分钟"], [30, "每 30 分钟"], [60, "每小时"], [120, "每 2 小时"],
  [360, "每 6 小时"], [720, "每 12 小时"], [1440, "每天"],
] as const;

type Settings = Pick<SyncStatus, "enabled" | "intervalMinutes">;
type Props = { onSynced?: () => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean };

function sameSettings(left: Settings | null, right: Settings | null) {
  return left?.enabled === right?.enabled && left?.intervalMinutes === right?.intervalMinutes;
}

function timeLabel(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

async function request<T>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "操作未完成，请稍后重试。");
  if (!body) throw new Error("无法读取同步状态，请重试。");
  return body as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "暂时无法连接服务，请稍后重试。";
}

export default function SyncSettings({ onSynced, onBusyChange, disabled = false }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"save" | "run" | null>(null);
  const [statusError, setStatusError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const statusRef = useRef<SyncStatus | null>(null);
  const draftRef = useRef<Settings | null>(null);
  const pending = useRef(false);
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSynced, onBusyChange });
  callbacks.current = { onSynced, onBusyChange };

  const updateDraft = (next: Settings) => {
    draftRef.current = next;
    setDraft(next);
    setNotice("");
    setActionError("");
  };

  const applyStatus = useCallback((next: SyncStatus, replaceDraft = false) => {
    const previous = statusRef.current;
    if (replaceDraft || !draftRef.current || sameSettings(draftRef.current, previous)) {
      const settings = { enabled: next.enabled, intervalMinutes: next.intervalMinutes };
      draftRef.current = settings;
      setDraft(settings);
    }
    statusRef.current = next;
    setStatus(next);
    if (previous && next.lastFinishedAt && next.lastFinishedAt !== previous.lastFinishedAt) {
      callbacks.current.onSynced?.();
    }
  }, []);

  const loadStatus = useCallback(async () => {
    if (pending.current) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const next = await request<SyncStatus>("/api/sync", { signal: controller.signal });
      if (sequence !== requestSequence.current || controller.signal.aborted) return;
      applyStatus(next);
      setStatusError("");
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setStatusError(controller.signal.aborted ? "读取同步状态超时，请重试。" : errorMessage(error));
    } finally {
      window.clearTimeout(timeout);
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 15_000);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
      controllerRef.current?.abort();
      callbacks.current.onBusyChange?.(false);
    };
  }, [loadStatus]);

  const busy = action !== null || status?.running === true;
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);

  const submit = async (kind: "save" | "run") => {
    if (pending.current || disabled || !draft || !status) return;
    if (kind === "run" && status.running) return;
    if (kind === "save" && draft.enabled && draft.intervalMinutes < status.minIntervalMinutes) {
      setActionError("请选择当前可用的同步间隔，再保存设置。");
      return;
    }
    pending.current = true;
    setAction(kind);
    setActionError("");
    setNotice("");
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    const timeout = window.setTimeout(() => controller.abort(), kind === "run" ? 230_000 : 20_000);
    try {
      const result = kind === "save"
        ? await request<SyncStatus>("/api/sync", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft), signal: controller.signal,
        })
        : (await request<{ status: SyncStatus }>("/api/sync/run", {
          method: "POST", signal: controller.signal,
        })).status;
      if (sequence !== requestSequence.current || controller.signal.aborted) return;
      applyStatus(result, kind === "save");
      setStatusError("");
      setNotice(kind === "save" ? "设置已保存。" : result.running
        ? "同步正在进行，完成后会更新状态。"
        : result.lastResult?.failed ? "同步已结束，部分来源未更新，请查看下方结果。" : "同步完成，文章列表已更新。");
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setActionError(controller.signal.aborted
        ? kind === "run" ? "等待同步结果超时，后台可能仍在处理，状态会自动更新。" : "保存结果尚未确认，请稍后刷新状态核对。"
        : errorMessage(error));
    } finally {
      window.clearTimeout(timeout);
      if (sequence === requestSequence.current) {
        pending.current = false;
        setAction(null);
        void loadStatus();
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit("save");
  };
  const dirty = !!draft && !!status && !sameSettings(draft, status);
  const invalidInterval = !!draft && !!status && draft.intervalMinutes < status.minIntervalMinutes;
  const heartbeatAge = status?.workerLastSeenAt ? Date.now() - Date.parse(status.workerLastSeenAt) : Infinity;
  const workerAvailable = !!status && Number.isFinite(heartbeatAge)
    && heartbeatAge < Math.max(status.triggerIntervalMinutes * 2, 3) * 60_000;
  const controlsDisabled = disabled || action !== null;

  return (
    <section className="sync-settings" aria-labelledby="sync-settings-title">
      <div className="sync-heading">
        <div>
          <h3 id="sync-settings-title"><Clock3 size={15} aria-hidden="true" />周期同步</h3>
          <p>后台按设置更新全部来源，关闭页面后仍会继续。</p>
        </div>
        {status && <span className="sync-state">{status.running ? "正在同步" : !status.enabled ? "已暂停" : workerAvailable ? "已启用" : "等待后台"}</span>}
      </div>

      {loading && !status && <p className="sync-loading" role="status"><LoaderCircle className="spin" size={14} />读取同步设置…</p>}
      {statusError && <div className="sync-error" role="alert">
        <span>{statusError}</span>
        <button type="button" className="text-button" disabled={action !== null} onClick={() => void loadStatus()}>重新读取</button>
      </div>}

      {status && draft && <>
        <form className="sync-form" onSubmit={handleSubmit}>
          <label className="sync-enabled">
            <input type="checkbox" checked={draft.enabled} disabled={controlsDisabled}
              onChange={event => updateDraft({ ...draft, enabled: event.target.checked })} />
            <span>自动同步</span>
          </label>
          <label className="sync-interval">
            <span>同步间隔</span>
            <select value={draft.intervalMinutes} disabled={controlsDisabled || !draft.enabled}
              onChange={event => updateDraft({ ...draft, intervalMinutes: Number(event.target.value) })}>
              {intervals.map(([value, label]) => <option key={value} value={value} disabled={value < status.minIntervalMinutes}>
                {label}{value < status.minIntervalMinutes ? "（暂不可用）" : ""}
              </option>)}
            </select>
          </label>
          <div className="sync-buttons">
            <button className="button primary" type="submit" disabled={controlsDisabled || !dirty || (draft.enabled && invalidInterval)}>
              {action === "save" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存设置
            </button>
            <button className="button secondary" type="button" disabled={controlsDisabled || status.running} onClick={() => void submit("run")}>
              {action === "run" || status.running ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
              {action === "run" || status.running ? "正在同步" : "立即同步"}
            </button>
          </div>
          {dirty && <span className="sync-unsaved">有未保存的修改</span>}
        </form>

        {invalidInterval && draft.enabled && <p className="sync-warning">当前间隔暂不可用，请选择可用的间隔并保存。</p>}
        <div className="sync-details">
          <p>{status.enabled
            ? !workerAvailable ? "设置已启用，但尚未检测到近期后台检查，自动同步可能尚未运行。" : "自动同步已启用。"
            : "已暂停自动同步，仍可手动刷新。"}</p>
          <dl className="sync-times">
            <div><dt>{status.running ? "本次开始" : "上次完成"}</dt><dd>{timeLabel(status.running ? status.lastStartedAt : status.lastFinishedAt)}</dd></div>
            <div><dt>下次计划</dt><dd>{status.enabled ? timeLabel(status.nextRunAt) : "已暂停"}</dd></div>
            <div><dt>后台最近检查</dt><dd>{status.workerLastSeenAt ? timeLabel(status.workerLastSeenAt) : "尚未检测到"}</dd></div>
          </dl>
          {status.lastResult && <p className="sync-result">
            上次同步 {status.lastResult.sources} 个来源，成功 {status.lastResult.succeeded} 个，失败 {status.lastResult.failed} 个；新增 {status.lastResult.inserted} 篇，更新 {status.lastResult.updated} 篇。
          </p>}
          {status.lastError && <p className="sync-last-error">{status.lastError}</p>}
        </div>
      </>}
      {actionError && <p className="sync-error" role="alert">{actionError}</p>}
      {notice && <p className="sync-notice" role="status">{notice}</p>}
    </section>
  );
}
