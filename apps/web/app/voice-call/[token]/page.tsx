import InternalWebCallPage from "@/components/InternalWebCallPage";

export const dynamic = "force-dynamic";
export const metadata = { referrer: "no-referrer" as const, robots: { index: false, follow: false } };

export default async function VoiceCallRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InternalWebCallPage token={token} />;
}
