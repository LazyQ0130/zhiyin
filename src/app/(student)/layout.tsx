import { AppShell } from "@/components/app-shell";
import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.profile?.onboarded) redirect("/onboarding");
  return <AppShell>{children}</AppShell>;
}
