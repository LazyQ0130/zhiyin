import Link from "next/link";
import { Brand } from "@/components/shared";
import { Button } from "@/components/ui/button";
export default function NotFound() { return <main className="public-page"><Brand /><div className="empty-state"><p className="eyebrow">404 · 页面未找到</p><h1>这条学习记录暂时无法打开</h1><p>记录可能已被删除，或不属于当前账户。</p><Button asChild><Link href="/home">返回学习首页</Link></Button></div></main>; }
