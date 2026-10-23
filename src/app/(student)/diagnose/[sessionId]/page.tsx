import { DiagnosisSessionPage } from "@/components/diagnosis";
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) { const { sessionId } = await params; return <DiagnosisSessionPage sessionId={sessionId} />; }
