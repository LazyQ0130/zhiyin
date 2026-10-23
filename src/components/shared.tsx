"use client";

import Link from "next/link";
import { AlertCircle, ArrowRight, BookOpen, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/ui-labels";

export function Brand() {
  return <Link href="/home" className="brand" aria-label="知因 AI 首页">
    <span className="brand-art">
      {/* Display the original transparent artwork without its surrounding canvas. */}
      <svg className="brand-logo" viewBox="180 390 1120 346" role="img" aria-label="知因 AI">
        <image href="/brand/zhiyin-logo.png" width="1448" height="1086" />
      </svg>
      <svg className="brand-symbol" viewBox="180 390 390 346" role="img" aria-label="知因 AI">
        <image href="/brand/zhiyin-logo.png" width="1448" height="1086" />
      </svg>
    </span>
    <small>让学习更有方向</small>
  </Link>;
}
export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action && <div className="page-action">{action}</div>}</header>; }
export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  const tone = status && ["SUPPORTED", "VERIFIED", "COMPLETED", "CORRECT", "PASSED_CURRENT_PROBE", "REPORT_READY"].includes(status) ? "mint" : status && ["HYPOTHESIS", "NEEDS_PRACTICE", "PENDING_DELAYED_RETEST", "NOT_STARTED", "HINTED"].includes(status) ? "amber" : "neutral";
  return <span className={`badge badge-${tone}`}>{children ?? label(status ?? "UNRESOLVED")}</span>;
}
export function LoadingState({ text = "正在打开你的学习空间…" }: { text?: string }) { return <div className="loading-state" role="status"><LoaderCircle size={24} className="spin" /><p>{text}</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>; }
export function ErrorState({ error, retry }: { error: string; retry?: () => void }) { return <div className="error-state" role="alert"><AlertCircle size={22} /><div><strong>这一步还没有完成</strong><p>{error}</p></div>{retry && <Button onClick={retry} variant="secondary" size="small"><RefreshCw size={15} />重试</Button>}</div>; }
export function EmptyState({ title, text, href = "/diagnose/new", cta = "开始第一次诊断" }: { title: string; text: string; href?: string; cta?: string }) { return <div className="empty-state"><span className="empty-icon"><BookOpen size={29} strokeWidth={1.5} /></span><h2>{title}</h2><p>{text}</p><Button asChild><Link href={href}>{cta}<ArrowRight size={17} /></Link></Button></div>; }
export function Notice({ children, icon = true }: { children: ReactNode; icon?: boolean }) { return <div className="notice">{icon && <ShieldCheck size={18} />}<div>{children}</div></div>; }
export function Field({ label: title, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <div className="field"><div className="field-label"><span>{title}</span>{hint && <small>{hint}</small>}</div>{children}</div>; }
