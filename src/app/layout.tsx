import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import SessionRefresh from "@/components/session-refresh";
import { isLocalDevelopment } from "@/lib/auth";

export const metadata: Metadata = {
  title: "大象 · 私人信息流",
  description: "把值得读的内容，留在自己的版面里。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head><body>{!isLocalDevelopment() && <SessionRefresh />}<ThemeProvider>{children}</ThemeProvider></body></html>;
}
