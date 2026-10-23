import { RecordDetailPage } from "@/components/records";
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) { const { sessionId } = await params; return <RecordDetailPage sessionId={sessionId} />; }
