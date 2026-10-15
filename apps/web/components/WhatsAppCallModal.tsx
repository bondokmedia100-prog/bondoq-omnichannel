"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { LoaderCircle, Mic, MicOff, PhoneCall, PhoneOff, ShieldCheck, Volume2, X } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";

type PermissionInfo = {
  status: string;
  transport: "WHATSAPP_CLOUD" | "INTERNAL_WEB";
  expiration: number | null;
  canStartCall: boolean;
  canRequestPermission: boolean;
  recordingEnabled: boolean;
  aiProcessingEnabled: boolean;
  iceServers?: RTCIceServer[];
};

function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      const sdp = peer.localDescription?.sdp || "";
      const hasUsableCandidate = /^a=candidate:.* typ (?:srflx|relay)\s/m.test(sdp);
      finish(hasUsableCandidate ? undefined : new Error("تعذر الوصول إلى مسار اتصال صالح. تحقق من الإنترنت أو جرّب شبكة أخرى."));
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

export default function WhatsAppCallModal({ conversationId, customerName, phone, socket, onClose }: {
  conversationId: string;
  customerName: string;
  phone: string;
  socket: Socket | null;
  onClose: () => void;
}) {
  const [permission, setPermission] = useState<PermissionInfo | null>(null);
  const [loadingPermission, setLoadingPermission] = useState(true);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [callStatus, setCallStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [aiProcessingConsent, setAiProcessingConsent] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("");
  const [error, setError] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingContextRef = useRef<AudioContext | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingSessionIdRef = useRef("");
  const recordingStartedAtRef = useRef(0);
  const sessionIdRef = useRef("");
  const appliedAnswerRef = useRef("");
  const permissionRequestedRef = useRef(false);

  async function refreshPermission() {
    try {
      const result = await api<PermissionInfo>(`/api/conversations/${conversationId}/whatsapp-call/permission`);
      setPermission(result);
      if (!result.recordingEnabled) setRecordingConsent(false);
      if (!result.aiProcessingEnabled) setAiProcessingConsent(false);
      if (result.canStartCall) { permissionRequestedRef.current = false; setPermissionRequested(false); }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر فحص إذن الاتصال");
    } finally { setLoadingPermission(false); }
  }

  async function refreshCall(id: string) {
    try {
      const result = await api<{ status: string; transport: "WHATSAPP_CLOUD" | "INTERNAL_WEB"; sdpAnswer?: string | null; error?: string | null; recordingEnabled?: boolean; aiProcessingEnabled?: boolean }>(`/api/whatsapp-calls/${id}`);
      if (sessionIdRef.current !== id) return;
      if (result.recordingEnabled) {
        recordingSessionIdRef.current = id;
        if (localStreamRef.current && remoteStreamRef.current) startCallRecording(localStreamRef.current, remoteStreamRef.current);
      }
      const peer = peerRef.current;
      if (result.sdpAnswer && result.sdpAnswer !== appliedAnswerRef.current && peer) {
        appliedAnswerRef.current = result.sdpAnswer;
        try {
          await peer.setRemoteDescription({ type: "answer", sdp: result.sdpAnswer });
          await api(`/api/whatsapp-calls/${id}/answer-applied`, { method: "POST", body: JSON.stringify({}) });
        } catch (reason) {
          if (appliedAnswerRef.current === result.sdpAnswer) appliedAnswerRef.current = "";
          throw reason;
        }
      }
      const terminal = ["REJECTED", "TERMINATED", "FAILED"].includes(result.status);
      setCallStatus((current) => terminal ? result.status
        : current === "CONNECTED" ? current
          : current === "RINGING" && result.status === "INITIATING" ? current
            : peerRef.current?.connectionState === "connected" ? "CONNECTED" : result.status);
      if (terminal) {
        setError(result.error || (result.status === "REJECTED" ? "رفض العميل المكالمة." : "انتهت المكالمة."));
        finishCallRecording();
        setRecordingConsent(false);
        setAiProcessingConsent(false);
        sessionIdRef.current = "";
        stopLocalMedia();
      }
    } catch (reason) {
      if (sessionIdRef.current !== id) return;
      setError(reason instanceof Error ? reason.message : "انقطع الاتصال بحالة المكالمة");
    }
  }

  async function uploadCallRecording(blob: Blob, id: string, durationSeconds: number) {
    if (blob.size > 12 * 1024 * 1024) throw new Error("حجم التسجيل تجاوز الحد المسموح (12 ميجابايت)؛ لن يُحفظ هذا الملف.");
    const contentType = blob.type.split(";")[0] || "audio/webm";
    const response = await fetch(`${API_URL}/api/whatsapp-calls/${id}/recording`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": contentType, "X-Duration-Seconds": String(durationSeconds) },
      body: blob
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "تعذر حفظ تسجيل المكالمة");
    setRecordingStatus("حُفظ التسجيل الصوتي بأمان.");
  }

  function startCallRecording(local: MediaStream, remote: MediaStream) {
    if (!permission?.recordingEnabled || !recordingSessionIdRef.current || mediaRecorderRef.current) return;
    let context: AudioContext | null = null;
    try {
      context = recordingContextRef.current ?? new AudioContext();
      if (context.state === "suspended") void context.resume().catch(() => setRecordingStatus("تعذر تفعيل تسجيل المكالمة في هذا المتصفح."));
      const mixedAudio = context.createMediaStreamDestination();
      context.createMediaStreamSource(local).connect(mixedAudio);
      context.createMediaStreamSource(remote).connect(mixedAudio);
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(mixedAudio.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 16_000 });
      recordingChunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      recordingContextRef.current = context;
      mediaRecorderRef.current = recorder;
      const sessionId = recordingSessionIdRef.current;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onerror = () => setRecordingStatus("تعذر تسجيل المكالمة؛ تحقق من دعم المتصفح للصوت.");
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const duration = Math.max(1, Math.ceil((Date.now() - recordingStartedAtRef.current) / 1000));
        recordingChunksRef.current = [];
        mediaRecorderRef.current = null;
        recordingSessionIdRef.current = "";
        recordingContextRef.current = null;
        void context?.close().catch(() => {});
        if (!sessionId || !blob.size) return;
        setRecordingStatus("جارٍ حفظ تسجيل المكالمة...");
        void uploadCallRecording(blob, sessionId, duration).catch((reason) => setRecordingStatus(reason instanceof Error ? reason.message : "تعذر حفظ تسجيل المكالمة."));
      };
      recorder.start(1000);
      setRecordingStatus("تسجيل المكالمة جارٍ بعد موافقة العميل.");
    } catch {
      void context?.close().catch(() => {});
      mediaRecorderRef.current = null;
      recordingContextRef.current = null;
      recordingSessionIdRef.current = "";
      setRecordingStatus("تعذر بدء التسجيل في هذا المتصفح. لن يتم حفظ صوت المكالمة.");
    }
  }

  function finishCallRecording() {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    else {
      void recordingContextRef.current?.close().catch(() => {});
      recordingContextRef.current = null;
      recordingSessionIdRef.current = "";
    }
  }

  function stopLocalMedia() {
    finishCallRecording();
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  useEffect(() => {
    void refreshPermission();
    const permissionTimer = window.setInterval(() => { if (permissionRequestedRef.current) void refreshPermission(); }, 10_000);
    const callTimer = window.setInterval(() => { if (sessionIdRef.current) void refreshCall(sessionIdRef.current); }, 1500);
    const callUpdate = (event: { sessionId?: string }) => {
      if (event?.sessionId && event.sessionId === sessionIdRef.current) void refreshCall(event.sessionId);
    };
    socket?.on("whatsapp:cloud-call-updated", callUpdate);
    return () => {
      window.clearInterval(permissionTimer);
      window.clearInterval(callTimer);
      socket?.off("whatsapp:cloud-call-updated", callUpdate);
      if (sessionIdRef.current) void api(`/api/whatsapp-calls/${sessionIdRef.current}/terminate`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      stopLocalMedia();
    };
  }, [conversationId, socket]);

  async function requestPermission() {
    setBusy(true); setError("");
    try {
      await api(`/api/conversations/${conversationId}/whatsapp-call/permission-request`, { method: "POST", body: JSON.stringify({}) });
      permissionRequestedRef.current = true;
      setPermissionRequested(true);
      setError("أُرسل طلب الإذن إلى واتساب العميل. ستتاح المكالمة بعد موافقته.");
      await refreshPermission();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر إرسال طلب إذن الاتصال"); }
    finally { setBusy(false); }
  }

  async function startCall() {
    if (busy || sessionIdRef.current) return;
    setBusy(true); setError("");
    appliedAnswerRef.current = "";
    let stream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    try {
      const currentPermission = await api<PermissionInfo>(`/api/conversations/${conversationId}/whatsapp-call/permission`);
      setPermission(currentPermission);
      if (!currentPermission.canStartCall) throw new Error("لا يتاح إذن اتصال جديد لهذا العميل حاليًا.");
      const useCloudCalling = currentPermission.transport !== "INTERNAL_WEB";
      if (useCloudCalling && currentPermission.recordingEnabled && !recordingConsent) throw new Error("سجّل موافقة العميل على تسجيل المكالمة قبل الاتصال.");
      if (useCloudCalling && currentPermission.aiProcessingEnabled && !aiProcessingConsent) throw new Error("سجّل موافقة العميل المنفصلة على المعالجة الآلية قبل الاتصال.");
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("يلزم فتح النظام عبر HTTPS والسماح باستخدام الميكروفون.");
      if (currentPermission.recordingEnabled) {
        if (useCloudCalling) {
          if (typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") throw new Error("تسجيل المكالمات غير مدعوم في هذا المتصفح؛ جرّب متصفحًا حديثًا قبل الاتصال.");
          const supportedType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].some((type) => MediaRecorder.isTypeSupported(type));
          if (!supportedType) throw new Error("تسجيل المكالمات غير مدعوم في هذا المتصفح؛ جرّب متصفحًا حديثًا قبل الاتصال.");
          recordingContextRef.current = new AudioContext();
          await recordingContextRef.current.resume();
        } else if (typeof AudioContext !== "undefined") {
          try {
            recordingContextRef.current = new AudioContext();
            await recordingContextRef.current.resume();
          } catch {
            await recordingContextRef.current?.close().catch(() => {});
            recordingContextRef.current = null;
          }
        }
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      peer = new RTCPeerConnection({ iceServers: currentPermission.iceServers?.length ? currentPermission.iceServers : [{ urls: "stun:stun.l.google.com:19302" }] });
      localStreamRef.current = stream;
      peerRef.current = peer;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      peer.ontrack = (event) => {
        const audio = remoteAudioRef.current;
        if (!audio) return;
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        remoteStreamRef.current = remoteStream;
        audio.srcObject = remoteStream;
        if (recordingSessionIdRef.current && localStreamRef.current) startCallRecording(localStreamRef.current, remoteStream);
        void audio.play().catch(() => setError("المكالمة متصلة. اضغط تشغيل الصوت إذا لم تسمع العميل."));
      };
      peer.onconnectionstatechange = () => {
        if (peer?.connectionState === "connected") setCallStatus("CONNECTED");
        if (peer?.connectionState === "failed") {
          setError("تعذر إنشاء مسار الصوت. تحقق من الشبكة ثم أعد الاتصال.");
          if (sessionIdRef.current) void endCall();
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const offerSdp = peer.localDescription?.sdp || "";
      if (!offerSdp.includes("m=audio") || !offerSdp.includes("a=candidate:")) throw new Error("لم يكتمل تجهيز اتصال الصوت. تحقق من اتصال الشبكة وأعد المحاولة.");
      const result = await api<{ sessionId: string; status: string; transport: "WHATSAPP_CLOUD" | "INTERNAL_WEB"; recordingEnabled: boolean; aiProcessingEnabled: boolean }>(`/api/conversations/${conversationId}/whatsapp-call`, {
        method: "POST", body: JSON.stringify({ offerSdp, recordingConsent, aiProcessingConsent })
      });
      sessionIdRef.current = result.sessionId;
      if (peer.connectionState === "failed") {
        void api(`/api/whatsapp-calls/${result.sessionId}/terminate`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
        sessionIdRef.current = "";
        throw new Error("تعذر إنشاء مسار الصوت. تحقق من الشبكة ثم أعد الاتصال.");
      }
      if (result.recordingEnabled) recordingSessionIdRef.current = result.sessionId;
      setRecordingStatus(result.transport === "INTERNAL_WEB" ? "أُرسل رابط الانضمام للعميل عبر WhatsApp. انتظر فتحه والرد على المكالمة." : "");
      setSessionId(result.sessionId);
      setCallStatus(result.status);
      if (result.recordingEnabled && localStreamRef.current && remoteStreamRef.current) startCallRecording(localStreamRef.current, remoteStreamRef.current);
      void refreshCall(result.sessionId);
    } catch (reason) {
      peer?.close();
      stream?.getTracks().forEach((track) => track.stop());
      finishCallRecording();
      peerRef.current = null;
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      setError(reason instanceof Error ? reason.message : "تعذر بدء المكالمة الصوتية");
    } finally { setBusy(false); }
  }

  async function endCall(closeAfter = false) {
    const id = sessionIdRef.current;
    let succeeded = false;
    setBusy(true);
    try {
      if (id) await api(`/api/whatsapp-calls/${id}/terminate`, { method: "POST", body: JSON.stringify({}) });
      setCallStatus("TERMINATED");
      setError("");
      succeeded = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إنهاء المكالمة لدى WhatsApp");
    } finally {
      if (succeeded && sessionIdRef.current === id) {
        finishCallRecording();
        setRecordingConsent(false);
        setAiProcessingConsent(false);
        sessionIdRef.current = "";
        stopLocalMedia();
      }
      setBusy(false);
      if (closeAfter && succeeded) onClose();
    }
  }

  function toggleMute() {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }

  const activeCall = Boolean(sessionId) && !["TERMINATED", "REJECTED", "FAILED"].includes(callStatus);
  const usesInternalWebCall = permission?.transport === "INTERNAL_WEB";
  const permissionLabel = usesInternalWebCall ? "دعوة متصفح آمنة عبر WhatsApp" : permission?.status === "permanent" ? "إذن دائم" : permission?.status === "temporary" ? "إذن مؤقت" : permission?.status === "no_permission" ? "لم يمنح العميل إذن الاتصال بعد" : permission?.status === "pending" ? "طلب الإذن بانتظار العميل" : "جارٍ التحقق من إذن العميل";
  const callLabel = callStatus === "CONNECTED" ? "المكالمة متصلة" : callStatus === "RINGING" ? usesInternalWebCall ? "العميل ينضم إلى المكالمة..." : "يرن واتساب لدى العميل..." : callStatus === "INITIATING" && usesInternalWebCall ? "بانتظار فتح العميل لرابط الاتصال..." : callStatus === "REJECTED" ? "رفض العميل المكالمة" : callStatus === "TERMINATED" ? "انتهت المكالمة" : callStatus === "FAILED" ? "تعذر إكمال المكالمة" : "جارٍ الاتصال بواتساب العميل...";

  return <div className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-stone-950/70 p-3 backdrop-blur-sm sm:p-5" dir="rtl">
    <section role="dialog" aria-modal="true" aria-labelledby="whatsapp-call-title" className="my-auto max-h-[calc(100dvh-24px)] w-full max-w-md overflow-y-auto rounded-3xl border border-white/60 bg-[#fffdf7] shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-stone-100 bg-white px-5 py-4 sm:px-6">
         <div className="flex min-w-0 items-center gap-3"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-100 text-emerald-700"><PhoneCall size={20}/></div><div className="min-w-0"><p className="text-[10px] font-bold text-emerald-700">{usesInternalWebCall ? "مكالمة متصفح عبر رابط WhatsApp" : "مكالمة صوتية عبر WhatsApp Cloud"}</p><h2 id="whatsapp-call-title" className="mt-0.5 truncate text-base font-extrabold text-stone-800">{customerName}</h2><p dir="ltr" className="mt-0.5 text-right text-[10px] text-stone-400">{phone}</p></div></div>
        <button type="button" disabled={busy} onClick={() => void endCall(true)} aria-label="إغلاق شاشة المكالمة" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-stone-400 hover:bg-stone-100 disabled:opacity-40"><X size={18}/></button>
      </header>
      <div className="space-y-4 p-5 sm:p-6">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        {activeCall ? <>
           <div className="rounded-2xl bg-emerald-50 px-4 py-5 text-center"><div className="mx-auto grid h-16 w-16 animate-pulse place-items-center rounded-full bg-white text-emerald-700 shadow-sm"><PhoneCall size={25}/></div><p role="status" aria-live="polite" className="mt-4 text-sm font-extrabold text-emerald-900">{callLabel}</p><p className="mt-1 text-[10px] text-emerald-700">{usesInternalWebCall ? "هذه مكالمة متصفح؛ يفتح العميل الرابط الذي وصل إليه في WhatsApp." : "الصوت يُنقل مباشرة بين متصفح الموظف وWhatsApp Cloud Calling."}</p></div>
          {recordingStatus && <p role="status" className="rounded-xl bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-900">{recordingStatus}</p>}
          {error && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-950">{error}</p>}
          <div className="grid grid-cols-2 gap-3"><button type="button" onClick={toggleMute} className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 py-3 text-xs font-bold ${muted ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-700"}`}>{muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? "فتح الميكروفون" : "كتم الميكروفون"}</button><button type="button" onClick={() => { void remoteAudioRef.current?.play().catch(() => {}); }} className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-stone-100 px-4 py-3 text-xs font-bold text-stone-700"><Volume2 size={16}/>تفعيل صوت العميل</button></div>
          <button type="button" disabled={busy} onClick={() => void endCall()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-xs font-extrabold text-white hover:bg-red-700 disabled:opacity-50"><PhoneOff size={17}/>{busy ? "جارٍ إنهاء المكالمة..." : "إنهاء المكالمة"}</button>
        </> : <>
           <div className="flex items-start gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-700"/><div><p className="text-xs font-extrabold text-emerald-950">{usesInternalWebCall ? "مكالمة صوتية عبر المتصفح" : "موافقة العميل مطلوبة من WhatsApp"}</p><p className="mt-1 text-[10px] leading-5 text-emerald-900">{usesInternalWebCall ? "سيصل للعميل رابط مؤقت عبر WhatsApp؛ يفتح الرابط ويوافق على الميكروفون للانضمام. هذه ليست مكالمة WhatsApp أصلية." : `${permissionLabel}. يظل الميكروفون مغلقًا حتى تبدأ الاتصال.`}</p></div></div>
           {permission?.recordingEnabled && !usesInternalWebCall && <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[10px] leading-5 text-amber-950"><input type="checkbox" checked={recordingConsent} onChange={(event) => setRecordingConsent(event.target.checked)} className="mt-1 shrink-0"/><span><b className="block text-xs">موافقة العميل على تسجيل المكالمة</b>اطلب موافقة العميل بوضوح على التسجيل، ثم أكد ذلك هنا قبل الاتصال. يبدأ التسجيل بعد اتصال الطرفين.</span></label>}
           {permission?.aiProcessingEnabled && !usesInternalWebCall && <label className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-[10px] leading-5 text-blue-950"><input type="checkbox" checked={aiProcessingConsent} onChange={(event) => setAiProcessingConsent(event.target.checked)} className="mt-1 shrink-0"/><span><b className="block text-xs">موافقة منفصلة على التفريغ والملخص الآليين</b>أكّد أن العميل وافق صراحةً على إرسال التسجيل والنص الناتج إلى OpenAI لإنشاء تفريغ وملخص.</span></label>}
          {error && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-950">{error}</p>}
          {permissionRequested && <p role="status" className="rounded-xl bg-blue-50 px-3 py-2.5 text-[10px] leading-5 text-blue-900">أُرسل طلب الإذن. ستتحدث الحالة تلقائيًا بعد رد العميل في WhatsApp.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
             <button type="button" disabled={busy || loadingPermission || !permission?.canStartCall || Boolean(permission?.transport !== "INTERNAL_WEB" && permission?.recordingEnabled && !recordingConsent) || Boolean(permission?.transport !== "INTERNAL_WEB" && permission?.aiProcessingEnabled && !aiProcessingConsent)} onClick={() => void startCall()} className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-xs font-extrabold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"><PhoneCall size={16}/>{busy ? "جارٍ تجهيز الميكروفون..." : usesInternalWebCall ? "إرسال رابط مكالمة" : "بدء مكالمة WhatsApp"}</button>
             {!usesInternalWebCall && <button type="button" disabled={busy || loadingPermission || !permission?.canRequestPermission || permission?.canStartCall} onClick={() => void requestPermission()} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-xs font-bold text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40">{busy || loadingPermission ? <LoaderCircle size={15} className="animate-spin"/> : <ShieldCheck size={15}/>}طلب إذن الاتصال</button>}
          </div>
          {!loadingPermission && !error && permission && !permission.canStartCall && !permission.canRequestPermission && <p className="text-center text-[10px] leading-5 text-stone-500">لا يسمح WhatsApp بطلب اتصال جديد حاليًا. تحقق من حدود الإذن أو حاول لاحقًا.</p>}
        </>}
        {!activeCall && recordingStatus && <p role="status" className="rounded-xl bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-900">{recordingStatus}</p>}
         {!activeCall && error && <p className="text-center text-[9px] leading-4 text-stone-500">{usesInternalWebCall ? "يلزم HTTPS وفتح رابط الدعوة والسماح بالميكروفون؛ أضف TURN لزيادة نجاح الاتصال عبر الشبكات المقيدة." : "تأكد أن رقم الشركة الإيرلندي (+353) مفعّل على Cloud API وأن إعدادات المكالمات وWebhook مكتملة."}</p>}
      </div>
    </section>
  </div>;
}
