"use client";

import { useState } from "react";
import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient();
export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main style={{ maxWidth: 380, margin: "12vh auto", padding: 24 }}>
    <h1 style={{ fontFamily: '"Kaiti SC", "Songti SC", serif', fontSize: 42, fontWeight: 500 }}>大象</h1>
    <p style={{ color: "#737373", marginBottom: 32 }}>登录自己的阅读空间</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      const data = new FormData(event.currentTarget);
      try {
        const { error } = await authClient.signIn.email({ email: String(data.get("email")), password: String(data.get("password")) });
        if (error) setError("邮箱或密码不正确，请重试。");
        else window.location.assign("/");
      } catch { setError("暂时无法登录，请稍后重试。"); }
      finally { setBusy(false); }
    }} style={{ display: "grid", gap: 16 }}>
      <label>邮箱<input required type="email" name="email" autoComplete="username" style={{ display: "block", width: "100%", padding: 12, border: "1px solid #ddd", marginTop: 8 }} /></label>
      <label>密码<input required type="password" name="password" autoComplete="current-password" style={{ display: "block", width: "100%", padding: 12, border: "1px solid #ddd", marginTop: 8 }} /></label>
      <button disabled={busy} style={{ background: "#222", color: "white", padding: 12, border: 0 }}>{busy ? "登录中…" : "进入大象"}</button>
      <p role="alert" style={{ color: "#a22626", minHeight: 24 }}>{error}</p>
    </form>
  </main>;
}
