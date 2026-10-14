"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, PhoneCall, PhoneOff, UserRound, X } from "lucide-react";

type IncomingCall = { callId: string; callerJid: string; phoneNumber?: string; customerName?: string; conversationId?: string; isVideo?: boolean };

export default function IncomingWhatsAppCallModal({ call, onReject, onOpenConversation, onDismiss }: {
  call: IncomingCall;
  onReject: () => Promise<void>;
  onOpenConversation: () => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const interval = window.setInterval(() => {
      const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextConstructor) return;
      const context = new AudioContextConstructor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.23);
      oscillator.onended = () => { void context.close(); };
    }, 1600);
    return () => window.clearInterval(interval);
  }, []);

  async function reject() {
    setBusy(true); setError("");
    try { await onReject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر رفض المكالمة وإرسال الرد"); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-[80] grid place-items-center bg-stone-950/60 p-4 backdrop-blur-sm" dir="rtl">
    <section role="dialog" aria-modal="true" aria-labelledby="incoming-call-title" className="panel relative w-full max-w-md overflow-hidden p-6 text-center shadow-2xl">
      <button type="button" onClick={onDismiss} aria-label="إخفاء إشعار المكالمة" className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><X size={18}/></button>
      <div className="mx-auto grid h-16 w-16 animate-pulse place-items-center rounded-full bg-emerald-100 text-emerald-700"><PhoneCall size={28}/></div>
      <p className="mt-4 text-[10px] font-bold uppercase tracking-wide text-emerald-700">مكالمة {call.isVideo ? "فيديو" : "صوتية"} واردة عبر WhatsApp</p>
      <h2 id="incoming-call-title" className="mt-1 text-xl font-extrabold text-stone-800">{call.customerName || "عميل واتساب"}</h2>
      <p dir="ltr" className="mt-1 text-sm text-stone-500">{call.phoneNumber || call.callerJid}</p>
      <div className="mt-5 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-right text-[10px] leading-5 text-amber-950"><AlertTriangle size={16} className="mt-0.5 shrink-0"/><p>المحرك الحالي يلتقط المكالمة ويرفضها فقط؛ لا يدعم الرد الصوتي أو نقل صوت WhatsApp إلى المتصفح.</p></div>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button type="button" disabled={busy} onClick={() => void reject()} className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"><PhoneOff size={16}/>{busy ? "جارٍ الرفض والإرسال..." : "رفض وإرسال رد تلقائي"}</button>
        <button type="button" disabled={!call.conversationId} onClick={onOpenConversation} className="flex items-center justify-center gap-2 rounded-xl bg-stone-800 px-4 py-3 text-xs font-bold text-white hover:bg-stone-900 disabled:opacity-40"><UserRound size={16}/>فتح محادثة العميل</button>
      </div>
      <p className="mt-3 text-[9px] leading-4 text-stone-400">يمكن تغيير نص الرد من إعدادات WhatsApp. عند إخفاء النافذة قد يستمر رنين WhatsApp.</p>
    </section>
  </div>;
}
