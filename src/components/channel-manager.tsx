"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import type { ChannelRecord } from "@/lib/contracts";

interface ChannelManagerProps {
  open: boolean;
  channels: ChannelRecord[];
  onClose: () => void;
  onChange: (channel: ChannelRecord) => Promise<void>;
}

export default function ChannelManager({ open, channels, onClose, onChange }: ChannelManagerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const close = () => {
    if (pending) return;
    setDrafts({});
    setNewName("");
    setError(null);
    setStatus("");
    onClose();
  };

  const save = async (event: FormEvent, id?: string) => {
    event.preventDefault();
    if (pending) return;
    const key = id ?? "new";
    const name = (id ? drafts[id] ?? channels.find(item => item.id === id)?.name ?? "" : newName).trim();
    setStatus("");
    if (!name) {
      setError({ id: key, message: "请填写分类名称。" });
      return;
    }
    if (channels.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError({ id: key, message: "已经有这个分类了，换一个名称吧。" });
      return;
    }
    if (id && channels.find(item => item.id === id)?.name === name) return;

    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort("timeout"), 20_000);
    setPending(key);
    setError(null);
    try {
      const response = await fetch(id ? `/api/channels/${encodeURIComponent(id)}` : "/api/channels", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as { channel?: ChannelRecord; error?: string } | null;
      if (!response.ok || !result?.channel) throw new Error(result?.error || "分类未能保存，请重试。");
      const saved = result.channel;
      window.clearTimeout(timeout);
      await onChange(saved);
      if (controller.signal.aborted) return;
      if (id) setDrafts(current => ({ ...current, [id]: saved.name }));
      else setNewName("");
      setStatus(id ? `已将分类改名为「${saved.name}」。` : `已添加「${saved.name}」，可以为它导入或归入信息源。`);
    } catch (cause) {
      if (!controller.signal.aborted || controller.signal.reason === "timeout") {
        setError({ id: key, message: controller.signal.reason === "timeout" ? "请求超时，请稍后重试。" : cause instanceof Error ? cause.message : "暂时无法连接服务，请重试。" });
      }
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPending(null);
      }
    }
  };

  return (
    <dialog ref={dialogRef} className="import-dialog channel-manager-dialog" aria-labelledby="channel-manager-heading"
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="dialog-content">
        <div className="dialog-heading"><div><span className="small-label">YOUR SECTIONS</span><h2 id="channel-manager-heading">管理分类</h2></div><button className="icon-button" onClick={close} aria-label="关闭分类管理" disabled={pending !== null}><X size={20} /></button></div>
        <p className="dialog-intro">给感兴趣的内容留一个位置。分类名称可以随时修改。</p>
        <div className="channel-manager-list">
          {channels.map(item => (
            <form key={item.id} className="channel-manager-form" onSubmit={event => save(event, item.id)}>
              <label className="field-label" htmlFor={`channel-name-${item.id}`}>分类名称</label>
              <div className="channel-name-input-row">
                <input id={`channel-name-${item.id}`} value={drafts[item.id] ?? item.name} onChange={event => { setDrafts(current => ({ ...current, [item.id]: event.target.value })); setError(null); setStatus(""); }} maxLength={24} disabled={pending !== null} autoComplete="off" aria-label={`${item.name}的分类名称`} aria-invalid={error?.id === item.id} aria-describedby={error?.id === item.id ? `channel-error-${item.id}` : undefined} />
                <button type="submit" className="button secondary" disabled={pending !== null || (drafts[item.id] ?? item.name).trim() === item.name} aria-label={`保存${item.name}分类名称`}>{pending === item.id ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />}保存</button>
              </div>
              {error?.id === item.id && <p className="channel-form-error" role="alert" id={`channel-error-${item.id}`}>{error.message}</p>}
            </form>
          ))}
        </div>
        <form className="channel-add-form" onSubmit={event => save(event)}>
          <label className="field-label" htmlFor="new-channel-name">新增分类</label>
          <div className="channel-name-input-row"><input id="new-channel-name" value={newName} onChange={event => { setNewName(event.target.value); setError(null); setStatus(""); }} maxLength={24} placeholder="例如：电影、科技、旅行" disabled={pending !== null} autoComplete="off" aria-invalid={error?.id === "new"} aria-describedby={error?.id === "new" ? "new-channel-error" : undefined} /><button type="submit" className="button primary" disabled={pending !== null}>{pending === "new" ? <LoaderCircle className="spinning" size={14} /> : <Plus size={14} />}添加</button></div>
          {error?.id === "new" && <p className="channel-form-error" role="alert" id="new-channel-error">{error.message}</p>}
        </form>
        {status && <p className="channel-manager-status" role="status"><Check size={14} />{status}</p>}
        <p className="channel-manager-note">「总览」始终显示全部内容。在「管理来源」中可以调整信息源所属的分类。</p>
      </div>
    </dialog>
  );
}
