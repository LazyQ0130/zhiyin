"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowRight, Check, CheckCheck, ImagePlus, LoaderCircle, Sparkles, X } from "lucide-react";
import { api, mutate, errorMessage } from "@/lib/client-api";
import type { GradeBand, ProblemDTO, SessionDTO, Subject } from "@/lib/contracts";
import { useMe } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState, Field, Notice, PageHeader } from "@/components/shared";
import { gradeLabels, subjectLabels } from "@/lib/ui-labels";

const subjects: Subject[] = ["MATH", "CHINESE", "ENGLISH", "PHYSICS", "CHEMISTRY", "OTHER"];
const reasons = ["题目没读懂", "不知道用什么知识", "不知道下一步", "算错了", "我不确定", "其他"];
type Attachment = { id: string; name: string; url: string };
export function NewDiagnosisPage() {
  const { me } = useMe(); const router = useRouter();
  const [grade, setGrade] = useState<GradeBand>(me.profile.gradeBand); const [subject, setSubject] = useState<Subject>(me.profile.preferredSubjects[0] ?? "MATH");
  const [question, setQuestion] = useState(""); const [process, setProcess] = useState(""); const [stuck, setStuck] = useState<string[]>([]); const [notAttempted, setNotAttempted] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]); const [confirmed, setConfirmed] = useState<{ problemId: string; revisionId: string } | null>(null);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [info, setInfo] = useState(""); const [bufferLoaded, setBufferLoaded] = useState(false);
  const uploadController = useRef<AbortController | null>(null); const fileInput = useRef<HTMLInputElement>(null); const attempt = useRef<string | null>(null); const requestKey = useRef<string | null>(null);
  const bufferKey = `zhiyin-input-${me.user.id}`;
  useEffect(() => {
    queueMicrotask(() => {
    try { const saved = sessionStorage.getItem(bufferKey); if (saved) { const draft = JSON.parse(saved) as { question?: string; process?: string; grade?: GradeBand; subject?: Subject; stuck?: string[]; notAttempted?: boolean }; setQuestion(draft.question ?? ""); setProcess(draft.process ?? ""); if (draft.grade) setGrade(draft.grade); if (draft.subject) setSubject(draft.subject); setStuck(draft.stuck ?? []); setNotAttempted(draft.notAttempted ?? false); } } catch { /* Corrupt local buffers never replace server records. */ }
    setBufferLoaded(true);
    });
  }, [bufferKey]);
  useEffect(() => { if (bufferLoaded) sessionStorage.setItem(bufferKey, JSON.stringify({ question, process, grade, subject, stuck, notAttempted })); }, [question, process, grade, subject, stuck, notAttempted, bufferLoaded, bufferKey]);
  function invalidate() { setConfirmed(null); attempt.current = null; requestKey.current = null; }
  async function upload(files: FileList | null) {
    if (!files || busy) return; setError("");
    const selected = Array.from(files); if (selected.length + attachments.length > 3) { setError("每道题最多上传 3 张图片，请重新选择。"); return; }
    if (selected.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) { setError("请选择 JPG、PNG 或 WEBP 图片，不支持 SVG 和其他文件。"); return; }
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) { setError("每张图片不能超过 10 MiB，请压缩后重试。"); return; }
    setBusy("upload"); const controller = new AbortController(); uploadController.current = controller;
    try { for (const file of selected) { const form = new FormData(); form.append("file", file); const result = await api<{ id: string }>("/uploads", { method: "POST", body: form, signal: controller.signal }); setAttachments((previous) => [...previous, { id: result.id, name: file.name, url: `/api/v1/uploads/${result.id}` }]); } invalidate(); setInfo("图片已私密保存。请识别后核对文字，或直接手动输入题目。"); } catch (reason) { if (reason instanceof Error && reason.name === "AbortError") setInfo("已取消上传，可重新选择图片。"); else setError(errorMessage(reason)); } finally { setBusy(""); uploadController.current = null; if (fileInput.current) fileInput.current.value = ""; }
  }
  async function createProblem() { return mutate<ProblemDTO>("/problems", { questionText: question, subject, gradeBand: grade, imageIds: attachments.map((item) => item.id) }); }
  async function recognize() {
    setBusy("recognize"); setError(""); invalidate();
    try { const problem = await createProblem(); const result = await mutate<{ questionText: string; warning: string; isDemo: boolean }>(`/problems/${problem.id}/recognize`); if (result.questionText) setQuestion(result.questionText); setInfo(result.warning || "识别已完成。公式和符号可能存在误差，请逐字核对后确认题目。"); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  }
  async function confirmQuestion() {
    if (!question.trim()) { setError("请先输入题目文字，或核对图片识别结果。"); return; }
    setBusy("confirm"); setError("");
    try { const problem = await createProblem(); const result = await mutate<{ problemId: string; revisionId: string }>(`/problems/${problem.id}/confirm`, { questionText: question }); setConfirmed(result); setInfo("题目已确认并保存。再留下你的真实思路，就可以开始诊断。"); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  }
  async function start() {
    if (!confirmed || busy) return; if (!process.trim() && !notAttempted) { setError("请写下你已经尝试的步骤，或勾选「还没开始做」。"); return; }
    setBusy("start"); setError(""); if (!requestKey.current) requestKey.current = crypto.randomUUID();
    try { if (!attempt.current) { const result = await mutate<{ id: string }>("/attempts", { problemId: confirmed.problemId, revisionId: confirmed.revisionId, rawProcess: notAttempted ? "" : process, stuckReasons: stuck, notAttempted }, "POST", requestKey.current); attempt.current = result.id; }
      const diagnosis = await mutate<SessionDTO>("/diagnoses", { attemptId: attempt.current }, "POST", requestKey.current); sessionStorage.removeItem(bufferKey); router.push(`/diagnose/${diagnosis.id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  }
  function loadExample() { setQuestion("解一元二次方程 x² - 5x + 6 = 0。"); setProcess("a=1,b=-5,c=6\nΔ=25+24=49\nx=(5±7)/2"); setSubject("MATH"); setGrade("HIGH_SCHOOL"); setStuck(["算错了"]); setNotAttempted(false); invalidate(); setInfo("已填入内置演示题与示例步骤。它们不是你的真实作答；本次流程将标记为演示诊断。"); }
  return <><PageHeader eyebrow="开始诊断" title="把你遇到的问题交给知因 AI" description="提供自己的思考过程，比只上传答案更有帮助。" /><div className="wizard-steps"><div className="wizard-step active"><i>{confirmed ? <Check size={13} /> : 1}</i>题目</div><span className="step-connector" /><div className={`wizard-step ${confirmed ? "active" : ""}`}><i>2</i>我的思路</div><span className="step-connector" /><div className={`wizard-step ${confirmed && (process || notAttempted) ? "active" : ""}`}><i>3</i>确认并开始</div></div><div className="entry-grid"><div><div className="two-fields"><Field label="目前学段"><select aria-label="目前学段" value={grade} onChange={(event) => { setGrade(event.target.value as GradeBand); invalidate(); }}>{Object.entries(gradeLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field><Field label="本题学科"><select aria-label="本题学科" value={subject} onChange={(event) => { setSubject(event.target.value as Subject); invalidate(); }}>{subjects.map((value) => <option key={value} value={value}>{subjectLabels[value]}</option>)}</select></Field></div><Field label="添加题目" hint="图片可选，也可直接输入文字"><div className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}><ImagePlus size={27} strokeWidth={1.6} /><strong>拖入题目图片，或点击上传</strong><p>JPG、PNG、WEBP · 每张 ≤ 10 MiB · 最多 3 张</p><input ref={fileInput} type="file" className="upload-input" tabIndex={-1} accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void upload(event.target.files)} aria-label="上传题目图片" /><Button size="small" variant="secondary" onClick={() => fileInput.current?.click()} disabled={!!busy}>＋ 从文件选择</Button></div><p className="form-helper">上传前请遮挡姓名、学校、学号和无关的人像信息。</p>{attachments.map((item) => <div className="upload-preview" key={item.id}><a href={item.url} target="_blank" rel="noreferrer" aria-label={`查看题目图片 ${item.name}`}><Image src={item.url} alt="已上传的题目图片" width={65} height={52} unoptimized /></a><span>{item.name}</span><CheckCheck size={15} /></div>)}{busy === "upload" && <Button variant="ghost" size="small" onClick={() => uploadController.current?.abort()}><X size={14} />取消上传</Button>}{attachments.length > 0 && <Button variant="secondary" size="small" disabled={!!busy} onClick={recognize}>{busy === "recognize" ? "正在识别…" : "识别图片中的题目"}</Button>}</Field><Field label="题目文字" hint="请核对公式、符号与题目条件"><textarea aria-label="题目文字" value={question} placeholder="在这里粘贴题目，或修正图片识别结果……" maxLength={10000} onChange={(event) => { setQuestion(event.target.value); invalidate(); }} /><div className="confirm-row">{confirmed ? <span className="confirmed-label"><Check size={16} />题目已确认</span> : <span className="form-helper">确认后才能进入正式诊断</span>}<Button variant="secondary" size="small" onClick={confirmQuestion} disabled={!!busy || !!confirmed}>{busy === "confirm" ? "正在保存…" : "确认题目"}</Button></div></Field>{me.aiMode === "mock" && <button className="sample-link" type="button" onClick={loadExample}><Sparkles size={14} />填入内置演示题，体验完整流程</button>}</div><div className="entry-side"><Notice><strong>为什么要写自己的思路？</strong>真实的步骤能帮助我们定位问题。一道题或一个错误答案，不能代表你的学习能力。</Notice><Field label="我的解题过程" hint="每行一个步骤"><textarea aria-label="我的解题过程" value={process} placeholder={notAttempted ? "诊断将从你对题目的理解开始。" : "写下你是怎样想的、算到哪一步……\n即使不完整，也很有帮助。"} maxLength={15000} disabled={notAttempted} onChange={(event) => { setProcess(event.target.value); attempt.current = null; requestKey.current = null; }} /><label className="check-label" style={{ marginTop: 11 }}><input type="checkbox" checked={notAttempted} onChange={(event) => { setNotAttempted(event.target.checked); attempt.current = null; requestKey.current = null; }} />还没开始做，不确定从哪里入手</label></Field><Field label="我现在遇到的问题" hint="可以多选"><div className="chip-group">{reasons.map((reason) => <button type="button" key={reason} className={`chip ${stuck.includes(reason) ? "selected" : ""}`} aria-pressed={stuck.includes(reason)} onClick={() => setStuck((values) => values.includes(reason) ? values.filter((value) => value !== reason) : [...values, reason])}>{reason}</button>)}</div></Field>{error && <ErrorState error={error} />}{info && <div className="toast" role="status">{info}</div>}<Button className="full-width" onClick={start} disabled={!confirmed || !!busy}>{busy === "start" ? <><LoaderCircle size={17} className="spin" />正在建立诊断…</> : <>开始学习诊断<ArrowRight size={17} /></>}</Button><p className="input-note">先追问，再提示。你的尝试会保存为只读快照。</p></div></div></>;
}
