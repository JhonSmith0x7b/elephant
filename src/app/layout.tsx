import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "大象 · 私人信息流",
  description: "把值得读的内容，留在自己的版面里。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
