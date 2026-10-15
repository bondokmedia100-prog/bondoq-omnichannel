"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";

type Invitation = {
  status: string;
  offerSdp?: string;
  customerName?: string;
  recordingAvailable: boolean;
  aiConsentAvailable: boolean;
  iceServers: RTCIceServer[];
};

function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      const sdp = peer.localDescription?.sdp || "";
      const hasUsableCandidate = /^a=candidate:.* typ (?:srflx|relay)\s/m.test(sdp);
      finish(hasUsableCandidate ? undefined : new Error("تعذر الوصول إلى مسار اتصال صالح. أعد المحاولة أو استخدم شبكة أخرى."));
    }, 30_000);
    const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
    function finish(error?: Error) {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      if (error) reject(error); else resolve();
    }
    peer.addEventListener("icegatheringstatechange", changed);
    if (peer.iceGatheringState === "complete") finish();
  });
}

export default function InternalWebCallPage({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [status, setStatus] = useState("LOADING");
  const [busy, setBusy] = useState(false);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [error, setError] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const statusRef = useRef("LOADING");

  function updateStatus(next: string) {
    statusRef.current = next;
    setStatus(next);
  }

  function stopMedia() {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  async function refreshInvitation() {
    try {
      const response = await fetch(`${API_URL}/api/public/voice-calls/${encodeURIComponent(token)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = new Error(body.error || "رابط المكالمة غير صالح أو انتهت صلاحيته.") as Error & { status?: number };
        reason.status = response.status;
        throw reason;
      }
      setInvitation(body);
      const terminalStatuses = ["REJECTED", "TERMINATED", "FAILED"];
      const terminal = terminalStatuses.includes(body.status);
      const currentStatus = statusRef.current;
      const currentTerminal = terminalStatuses.includes(currentStatus);
      const nextStatus = currentTerminal ? currentStatus
        : terminal ? body.status
          : peerRef.current?.connectionState === "connected" ? "CONNECTED"
            : currentStatus === "RINGING" && body.status === "INITIATING" ? "RINGING" : body.status;
      updateStatus(nextStatus);
      if (terminal) stopMedia();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحميل دعوة المكالمة");
      const httpStatus = (reason as Error & { status?: number })?.status;
      if (httpStatus === 404 || httpStatus === 410 || statusRef.current === "LOADING") {
        updateStatus("FAILED");
        stopMedia();
      }
    }
  }

  useEffect(() => {
    void refreshInvitation();
    const timer = window.setInterval(() => {
      if (!["REJECTED", "TERMINATED", "FAILED"].includes(statusRef.current)) void refreshInvitation();
    }, 2000);
    return () => { window.clearInterval(timer); stopMedia(); };
  }, [token]);

  async function answerCall() {
    if (!invitation?.offerSdp || busy || peerRef.current) return;
    setBusy(true); setError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("افتح الرابط عبر HTTPS واسمح باستخدام الميكروفون.");
      const peer = new RTCPeerConnection({ iceServers: invitation.iceServers });
      peerRef.current = peer;
      peer.ontrack = (event) => {
        if (!remoteAudioRef.current) return;
        remoteAudioRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
        void remoteAudioRef.current.play().catch(() => setError("المكالمة متصلة. اضغط «تشغيل صوت الموظف» لسماع الطرف الآخر."));
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") { updateStatus("CONNECTED"); setError(""); }
        if (peer.connectionState === "failed") {
          setError("تعذر توصيل الصوت. أغلق الصفحة واطلب رابطًا جديدًا أو جرّب شبكة أخرى.");
          void finishCall("terminate");
        }
      };
      await peer.setRemoteDescription({ type: "offer", sdp: invitation.offerSdp });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      localStreamRef.current = stream;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer);
      const answerSdp = peer.localDescription?.sdp || "";
      if (!answerSdp.includes("m=audio") || !answerSdp.includes("a=candidate:")) throw new Error("لم يكتمل تجهيز اتصال الصوت. تحقق من الشبكة وحاول مجددًا.");
      const response = await fetch(`${API_URL}/api/public/voice-calls/${encodeURIComponent(token)}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerSdp, recordingConsent, aiProcessingConsent: aiConsent })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "تعذر الانضمام إلى المكالمة");
      updateStatus("RINGING");
    } catch (reason) {
      stopMedia();
      setError(reason instanceof Error ? reason.message : "تعذر الرد على المكالمة");
    } finally { setBusy(false); }
  }

  async function finishCall(action: "decline" | "terminate") {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${API_URL}/api/public/voice-calls/${encodeURIComponent(token)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      });
      if (!response.ok) throw new Error("تعذر إنهاء المكالمة");
      updateStatus(action === "decline" ? "REJECTED" : "TERMINATED");
      stopMedia();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر إنهاء المكالمة"); }
    finally { setBusy(false); }
  }

  const active = ["RINGING", "CONNECTED"].includes(status);
  const title = status === "CONNECTED" ? "المكالمة متصلة" : status === "RINGING" ? "جارٍ توصيل الصوت..." : status === "INITIATING" ? "دعوة صوتية من خدمة عملاء حلواني بندق" : status === "REJECTED" ? "لم ينضم العميل إلى المكالمة" : status === "TERMINATED" ? "انتهت المكالمة" : status === "FAILED" ? "تعذر فتح المكالمة" : "جارٍ تحميل الدعوة...";

  return <main dir="rtl" className="grid min-h-screen place-items-center bg-[#f7f5f1] p-4 text-stone-800">
    <section className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-6 shadow-xl sm:p-8">
      <div className="mb-5 flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-100 text-emerald-800"><span className="text-xl">☎</span></span><div><p className="text-xs font-bold text-emerald-800">حلواني بندق</p><h1 className="mt-1 text-lg font-extrabold">مكالمة صوتية عبر المتصفح</h1></div></div>
      <p className="rounded-2xl bg-stone-50 px-4 py-4 text-sm leading-7">{title}{invitation?.customerName ? ` · ${invitation.customerName}` : ""}</p>
      <p className="mt-4 text-xs leading-6 text-stone-600">هذه مكالمة متصفح آمنة أُرسل رابطها عبر WhatsApp، وليست مكالمة WhatsApp الأصلية. اسمح بالميكروفون بعد الضغط على الرد. لا تُرسل أي بيانات إلى WhatsApp سوى رابط الدعوة.</p>
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {invitation?.recordingAvailable && !active && status === "INITIATING" && <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6"><input type="checkbox" checked={recordingConsent} onChange={(event) => { setRecordingConsent(event.target.checked); if (!event.target.checked) setAiConsent(false); }} className="mt-1"/><span>أوافق على تسجيل هذه المكالمة الصوتية (اختياري). يمكنك الانضمام دون التسجيل.</span></label>}
      {invitation?.aiConsentAvailable && recordingConsent && !active && status === "INITIATING" && <label className="mt-3 flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs leading-6"><input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} className="mt-1"/><span>أوافق بشكل منفصل على إرسال التسجيل إلى OpenAI للتفريغ والملخص الآليين.</span></label>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-6 text-red-800">{error}</p>}
      {active ? <div className="mt-5 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => void remoteAudioRef.current?.play().catch(() => {})} className="rounded-xl bg-stone-100 px-4 py-3 text-sm font-bold">تشغيل صوت الموظف</button><button type="button" disabled={busy} onClick={() => void finishCall("terminate")} className="rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">إنهاء المكالمة</button></div>
        : status === "INITIATING" ? <div className="mt-5 grid gap-2 sm:grid-cols-2"><button type="button" disabled={busy || !invitation?.offerSdp} onClick={() => void answerCall()} className="rounded-xl bg-emerald-700 px-4 py-3 text-sm font-extrabold text-white disabled:opacity-40">{busy ? "جارٍ الاتصال..." : "الرد على المكالمة"}</button><button type="button" disabled={busy} onClick={() => void finishCall("decline")} className="rounded-xl border border-stone-200 px-4 py-3 text-sm font-bold disabled:opacity-50">رفض الدعوة</button></div>
          : null}
      <p className="mt-5 text-center text-[10px] leading-5 text-stone-400">إذا لم يبدأ الصوت، تأكد من السماح بالميكروفون واتصال الإنترنت، ثم اطلب من الموظف إعادة إرسال الدعوة.</p>
    </section>
  </main>;
}
