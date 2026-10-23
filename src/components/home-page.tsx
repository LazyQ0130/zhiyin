"use client";
import Link from "next/link";
import { ArrowRight, Check, Clock3, Plus, Sprout } from "lucide-react";
import { useApi } from "@/lib/client-api";
import type { DashboardDTO } from "@/lib/contracts";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { RecordList } from "@/components/record-list";
export function HomePage() {
  const { data, error, reload } = useApi<DashboardDTO>("/dashboard");
  return <><PageHeader eyebrow="学习工作台 · 今日概览" title="继续从一个卡点开始。" description="不只是知道答案，更重要的是弄清哪里没想通。" action={<Button asChild><Link href="/diagnose/new"><Plus size={18} />开始一次诊断</Link></Button>} />{error ? <ErrorState error={error.message} retry={reload} /> : !data ? <LoadingState /> : <><div className="home-grid"><section className="focus-card"><div className="focus-kicker"><Sprout size={17} />{data.focus ? "当前最值得解决的学习问题" : "每一次卡住，都有一个新的起点"}</div><h2>{data.focus?.title || "从一道让你困惑的题开始"}</h2><p>{data.focus ? "回到真实的解题过程，把尚未确认的地方再检查一次。" : "写下题目和自己的思路，我们一步步找到问题出在哪里。"}</p><div className="card-bottom"><Badge status={data.focus?.findingStatus ?? "UNRESOLVED"}>{data.focus ? undefined : "等待你的第一道题"}</Badge><Button variant="secondary" size="small" asChild><Link href={data.focus ? `/diagnose/${data.focus.id}` : "/diagnose/new"}>{data.focus ? "继续诊断" : "开始探索"}<ArrowRight size={15} /></Link></Button></div></section><div className="stat-stack"><Link href="/practice" className="stat-card"><span className="stat-icon"><Clock3 size={23} strokeWidth={1.6} /></span><div><p>待训练 / 复测</p><strong className="stat-number">{data.stats.pendingPractice}<small>项</small></strong></div></Link><Link href="/records" className="stat-card"><span className="stat-icon blue"><Check size={24} strokeWidth={1.6} /></span><div><p>诊断记录</p><strong className="stat-number">{data.stats.diagnoses}<small>次</small></strong></div></Link></div></div><section className="section-space"><div className="section-header"><h2>最近的学习记录</h2><Link href="/records">查看全部 →</Link></div>{data.recent.length ? <RecordList items={data.recent.slice(0, 5)} compact /> : <EmptyState title="你的学习档案，从这里开始" text="这里将记录你的真实尝试、每次追问和验证证据。暂时没有学习记录。" cta="上传一道你卡住的题" />}</section></>}</>;
}
