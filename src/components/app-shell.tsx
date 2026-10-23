"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect } from "react";
import { Archive, Brain, Home, MoreHorizontal, Plus, Settings2, Target } from "lucide-react";
import { ApiError, useApi } from "@/lib/client-api";
import type { MeDTO, Theme } from "@/lib/contracts";
import { Brand, ErrorState, LoadingState } from "@/components/shared";

const navigation = [
  { href: "/home", label: "首页", icon: Home }, { href: "/diagnose/new", label: "开始诊断", icon: Plus },
  { href: "/diagnose", label: "学习诊断", icon: Brain }, { href: "/practice", label: "针对训练", icon: Target },
  { href: "/records", label: "学习档案", icon: Archive }, { href: "/me", label: "我的", icon: Settings2 },
];
const UserContext = createContext<{ me: MeDTO; refreshMe: () => void } | null>(null);
export function useMe() { const value = useContext(UserContext); if (!value) throw new Error("学习空间尚未准备完成"); return value; }
export function applyTheme(theme: Theme, reducedMotion: boolean) {
  if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.reducedMotion = String(reducedMotion);
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(); const router = useRouter(); const { data: me, error, reload } = useApi<MeDTO>("/me");
  useEffect(() => { if (error instanceof ApiError && error.status === 401) router.replace("/login"); }, [error, router]);
  useEffect(() => { if (me) { applyTheme(me.profile.theme, me.profile.reducedMotion); if (!me.profile.onboarded) router.replace("/onboarding"); } }, [me, router]);
  const current = pathname.startsWith("/diagnose/new") ? navigation[1] : navigation.find((item) => pathname.startsWith(item.href)) ?? navigation[0];
  if (!me) return <main className="public-page"><Brand />{error && !(error instanceof ApiError && error.status === 401) ? <ErrorState error={error.message} retry={reload} /> : <LoadingState />}</main>;
  const initial = (me.profile.displayName || "学习者").slice(0, 1);
  return <UserContext.Provider value={{ me, refreshMe: reload }}><div className="app-shell"><aside className="sidebar"><Brand /><p className="nav-label">学习空间</p><nav className="main-nav" aria-label="主导航">{navigation.map((item) => <Link key={item.href} href={item.href} className={`nav-item ${current.href === item.href ? "active" : ""}`} aria-current={current.href === item.href ? "page" : undefined} title={item.label}><item.icon size={20} strokeWidth={1.6} /><span>{item.label}</span></Link>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><strong>一步步找到卡点</strong><p>先理解问题，再针对练习</p></div><Link className="sidebar-user" href="/me"><div className="avatar">{initial}</div><div><strong>{me.profile.displayName || "学习者"}</strong><small>个人学习空间</small></div><MoreHorizontal size={18} /></Link></div></aside><div className="shell-main"><div className="topbar"><div className="breadcrumb">知因 AI <span>/</span> {current.label}</div><div className="topbar-right">{me.aiMode === "mock" && <span className="environment-badge">演示模式 · Mock</span>}<span className="space-status"><i />封闭试测</span><Link href="/me" className="avatar" aria-label="我的账户">{initial}</Link></div></div><main className="workspace" id="main-content">{children}</main></div><nav className="mobile-nav" aria-label="移动端主导航">{navigation.map((item) => <Link key={item.href} href={item.href} className={current.href === item.href ? "active" : ""} aria-current={current.href === item.href ? "page" : undefined}><item.icon size={20} strokeWidth={1.6} /><span>{item.label}</span></Link>)}</nav></div></UserContext.Provider>;
}
