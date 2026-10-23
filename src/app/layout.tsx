import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "@/styles/globals.css";

export const metadata: Metadata = { title: { default: "知因 AI · 让学习更有方向", template: "%s · 知因 AI" }, description: "从真实解题过程出发，找到卡点，针对练习，逐步验证。仅限受邀成年用户封闭试测。" };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN" suppressHydrationWarning><body>{children}</body></html>; }
