"use client";
import { ErrorState } from "@/components/shared";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="public-page"><ErrorState error="页面加载遇到了问题。已提交的学习记录仍由服务器保存。" retry={reset} /></main>; }
