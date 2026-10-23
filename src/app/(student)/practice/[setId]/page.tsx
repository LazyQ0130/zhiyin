import { PracticeSessionPage } from "@/components/practice";
export default async function Page({ params }: { params: Promise<{ setId: string }> }) { const { setId } = await params; return <PracticeSessionPage setId={setId} />; }
