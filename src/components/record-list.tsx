import Link from "next/link";
import { Brain, ChevronRight, Clock3 } from "lucide-react";
import type { SessionSummary } from "@/lib/contracts";
import { Badge } from "@/components/shared";
import { dateText, gradeLabels, subjectLabels } from "@/lib/ui-labels";
export function RecordList({ items, compact = false, destination = "records" }: { items: SessionSummary[]; compact?: boolean; destination?: "records" | "diagnose" }) {
  return <div className="record-list">{items.map((item) => <Link key={item.id} href={`/${destination}/${item.id}`} className={`record-row ${compact ? "compact" : ""}`}>{compact ? <span className="record-dot" /> : <span className="record-symbol">{item.practiceSetId ? <Clock3 size={20} /> : <Brain size={20} />}</span>}<div className="record-main"><h3>{item.title || item.questionText}</h3><p>{gradeLabels[item.gradeBand]} · {subjectLabels[item.subject]} · {dateText(item.createdAt)}{item.isDemo ? " · 演示诊断" : ""}</p></div><Badge status={item.status} />{!compact && <ChevronRight size={16} />}</Link>)}</div>;
}
