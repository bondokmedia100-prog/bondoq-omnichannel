"use client";

import { useEffect, useState } from "react";
import { Activity, Archive, AudioLines, LoaderCircle, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";

type Recording = { id: string; durationSeconds: number; transcript: string | null; summary: string | null; reviewedAt: string | null };
type CallSession = {
  id: string;
  direction: string;
  status: string;
  recordingConsentAt: string | null;
  recordingDeletedAt: string | null;
  createdAt: string;
  endedAt: string | null;
  conversation: { id: string; customer: { name: string } };
  agent: { name: string };
  recording: Recording | null;
};

const statusLabel: Record<string, string> = { INITIATING: "جارٍ البدء", RINGING: "يرن", CONNECTED: "متصلة", TERMINATED: "انتهت", REJECTED: "مرفوضة", FAILED: "فشلت" };
const dateLabel = (value: string) => new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" });
const durationLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function RecordingReview({ session, canManage, hiding, onSaved, onDeleted, onHidden }: { session: CallSession; canManage: boolean; hiding: boolean; onSaved: (id: string, recording: Recording) => void; onDeleted: (id: string) => void; onHidden: (id: string) => void }) {
  const [transcript, setTranscript] = useState(session.recording?.transcript || "");
  const [summary, setSummary] = useState(session.recording?.summary || "");
  const [audioUrl, setAudioUrl] = useState("");
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [reviewDirty, setReviewDirty] = useState(false);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    if (reviewDirty) return;
    setTranscript(session.recording?.transcript || "");
    setSummary(session.recording?.summary || "");
  }, [reviewDirty, session.recording?.transcript, session.recording?.summary]);

  async function loadAudio() {
    if (!session.recording) return;
    setLoadingAudio(true); setNotice("");
    try {
      const response = await fetch(`${API_URL}/api/admin/call-recordings/${session.recording.id}/audio`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "تعذر تشغيل التسجيل");
      }
      setAudioUrl(URL.createObjectURL(await response.blob()));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تشغيل التسجيل"); }
    finally { setLoadingAudio(false); }
  }

  async function saveReview() {
    if (!session.recording) return;
    setSaving(true); setNotice("");
    try {
      const saved = await api<Recording>(`/api/admin/call-recordings/${session.recording.id}`, { method: "PATCH", body: JSON.stringify({ transcript, summary }) });
      onSaved(session.id, saved);
      setTranscript(saved.transcript || "");
      setSummary(saved.summary || "");
      setReviewDirty(false);
      setNotice("حُفظ التفريغ والملخص في سجل المكالمة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ المراجعة"); }
    finally { setSaving(false); }
  }

  async function deleteRecording() {
    if (!session.recording || !window.confirm("سيُحذف التسجيل الصوتي والتفريغ والملخص نهائيًا من الاستضافة، وسيبقى سجل المكالمة. هل تريد المتابعة؟")) return;
    setDeleting(true); setNotice("");
    try {
      await api(`/api/admin/call-recordings/${session.recording.id}`, { method: "DELETE" });
      setAudioUrl("");
      setTranscript("");
      setSummary("");
      setReviewDirty(false);
      onDeleted(session.id);
      setNotice("حُذف التسجيل نهائيًا من الاستضافة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف التسجيل"); }
    finally { setDeleting(false); }
  }

  return <article className="rounded-2xl border border-stone-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="text-sm text-stone-800">{session.conversation.customer.name || "عميل"}</b><span className="rounded-full bg-stone-100 px-2 py-1 text-[9px] font-bold text-stone-600">{statusLabel[session.status] || session.status}</span>{session.recordingConsentAt && <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-700"><ShieldCheck size={12}/>موافقة تسجيل</span>}</div><p className="mt-1 text-[10px] text-stone-500">الموظف: {session.agent.name} · {dateLabel(session.createdAt)}{session.endedAt ? ` · انتهت ${dateLabel(session.endedAt)}` : ""}</p></div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{session.recording && <><span className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] font-extrabold text-amber-800">مدة التسجيل {durationLabel(session.recording.durationSeconds)}</span>{canManage && <button type="button" disabled={deleting || saving || loadingAudio} onClick={() => void deleteRecording()} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-[10px] font-bold text-red-700 hover:bg-red-50 disabled:opacity-50">{deleting ? <LoaderCircle size={13} className="animate-spin"/> : <Trash2 size={13}/>}حذف التسجيل</button>}</>}{canManage && <button type="button" disabled={hiding} onClick={() => onHidden(session.id)} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[10px] font-bold text-stone-600 hover:bg-stone-50 disabled:opacity-50">{hiding ? <LoaderCircle size={13} className="animate-spin"/> : <Archive size={13}/>}إخفاء من القائمة</button>}</div>
     </div>
     {session.recording ? <div className="mt-4 space-y-3 border-t border-stone-100 pt-3">
       {audioUrl ? <audio controls preload="metadata" src={audioUrl} className="w-full" /> : <button type="button" disabled={loadingAudio} onClick={() => void loadAudio()} className="flex min-h-10 items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 disabled:opacity-50">{loadingAudio ? <LoaderCircle size={15} className="animate-spin"/> : <AudioLines size={15}/>}تشغيل التسجيل بأمان</button>}
       <label className="block text-[10px] font-bold text-stone-600">نص المكالمة (للمراجعة والتعديل)<textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); setReviewDirty(true); }} maxLength={30_000} rows={4} className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-xs font-normal leading-5" /></label>
       <label className="block text-[10px] font-bold text-stone-600">ملخص المكالمة (للمراجعة والتعديل)<textarea value={summary} onChange={(event) => { setSummary(event.target.value); setReviewDirty(true); }} maxLength={5_000} rows={2} className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-xs font-normal leading-5" /></label>
       <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[9px] text-stone-400">{session.recording.reviewedAt ? `آخر مراجعة: ${dateLabel(session.recording.reviewedAt)}` : "لم تتم المراجعة بعد"}</span><button type="button" disabled={saving || deleting} onClick={() => void saveReview()} className="flex items-center gap-2 rounded-lg bg-stone-800 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-50">{saving ? <LoaderCircle size={13} className="animate-spin"/> : <Save size={13}/>}حفظ المراجعة</button></div>
     </div> : <p className="mt-3 rounded-xl bg-stone-50 px-3 py-2 text-[10px] leading-5 text-stone-500">{session.recordingDeletedAt ? "حُذف التسجيل نهائيًا من الاستضافة." : session.recordingConsentAt ? "لا يوجد تسجيل محفوظ لهذه المكالمة؛ تحقق من سجل المتصفح أو حجم الملف." : "لا يوجد تسجيل محفوظ لهذه المكالمة، ولم تُسجّل موافقة على التسجيل."}</p>}
    {notice && <p role="status" className="mt-3 text-[10px] leading-5 text-stone-600">{notice}</p>}
  </article>;
}

export default function CallRecordingsModal({ onClose, canManage, canViewRecords }: { onClose: () => void; canManage: boolean; canViewRecords: boolean }) {
  const [sessions, setSessions] = useState<CallSession[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingSetting, setSavingSetting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hidingId, setHidingId] = useState("");

  useEffect(() => {
    void Promise.all([
      canViewRecords ? api<CallSession[]>("/api/admin/call-recordings").then(setSessions) : Promise.resolve(null),
      canManage ? api<{ enabled: boolean }>("/api/admin/call-recordings/settings").then((settings) => setEnabled(settings.enabled)) : Promise.resolve(null)
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : "تعذر تحميل سجل المكالمات"))
      .finally(() => setLoading(false));
  }, [canManage, canViewRecords]);

  useEffect(() => {
    if (!canViewRecords) return;
    const timer = window.setInterval(() => {
      void api<CallSession[]>("/api/admin/call-recordings").then(setSessions).catch(() => {});
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [canViewRecords]);

  async function updateSettings(nextEnabled: boolean) {
    setSavingSetting(true); setError(""); setNotice("");
    try {
      const saved = await api<{ enabled: boolean }>("/api/admin/call-recordings/settings", { method: "PUT", body: JSON.stringify({ enabled: nextEnabled, aiProcessingEnabled: false }) });
      setEnabled(saved.enabled);
      setNotice(saved.enabled ? "التسجيل مفعّل بموافقة العميل؛ تبقى التسجيلات محفوظة حتى حذفها يدويًا." : "أُوقف تسجيل المكالمات الجديدة.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر تحديث إعداد التسجيل"); }
    finally { setSavingSetting(false); }
  }

  function savedReview(sessionId: string, recording: Recording) {
    setSessions((old) => old.map((session) => session.id === sessionId ? { ...session, recording } : session));
  }

  function deletedRecording(sessionId: string) {
    setSessions((old) => old.map((session) => session.id === sessionId ? { ...session, recording: null, recordingDeletedAt: new Date().toISOString() } : session));
  }

  async function hideSession(sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || !window.confirm("إخفاء سجل هذه المكالمة من القائمة؟ سيظل التسجيل الصوتي محفوظًا.") ) return;
    setHidingId(sessionId); setError(""); setNotice("");
    try {
      await api(`/api/admin/call-recordings/sessions/${sessionId}`, { method: "DELETE" });
      setSessions((old) => old.filter((item) => item.id !== sessionId));
      setNotice("أُخفي سجل المكالمة من القائمة، وبقي التسجيل محفوظًا.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر إخفاء سجل المكالمة"); }
    finally { setHidingId(""); }
  }

  return <div className="fixed inset-0 z-[80] grid place-items-center bg-stone-950/50 p-3 backdrop-blur-sm" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="call-recordings-title" dir="rtl" className="flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white bg-[#fffdf7] shadow-2xl" onClick={(event) => event.stopPropagation()}>
       <header className="flex items-start justify-between gap-3 border-b border-stone-100 bg-white px-5 py-4 sm:px-6"><div><h2 id="call-recordings-title" className="text-base font-extrabold text-stone-800">تسجيلات ومراجعة المكالمات</h2><p className="mt-1 text-[10px] text-stone-500">سجل آخر 50 مكالمة عبر WhatsApp · تبقى التسجيلات محفوظة حتى حذفها يدويًا</p></div><button type="button" onClick={onClose} aria-label="إغلاق سجل المكالمات" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18}/></button></header>
      <div className="soft-scroll flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {canManage && <div className="space-y-3 rounded-2xl border border-amber-100 bg-amber-50/70 p-4"><div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-amber-800"><Activity size={17}/></div><div><b className="block text-xs text-amber-950">إعدادات تسجيل المكالمات ومراجعتها</b><p className="mt-1 max-w-lg text-[10px] leading-5 text-amber-900">يبدأ التسجيل بعد اتصال الطرفين فقط وبعد تأكيد الموظف موافقة العميل. لا يُنشأ تفريغ أو ملخص آلي، ولا يُحذف أي تسجيل تلقائيًا.</p></div></div><label className="flex items-start gap-2 rounded-xl bg-white px-3 py-2.5 text-xs font-bold text-stone-700"><input type="checkbox" checked={enabled} disabled={savingSetting} onChange={(event) => void updateSettings(event.target.checked)} className="mt-0.5"/><span>تسجيل المكالمات بموافقة العميل</span>{savingSetting && <LoaderCircle size={13} className="mr-auto animate-spin"/>}</label></div>}
        {notice && <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-[10px] text-emerald-800">{notice}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-[10px] text-red-700">{error}</p>}
          {loading ? <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-stone-500"><LoaderCircle className="animate-spin" size={16}/>جارٍ تحميل السجل...</div> : !canViewRecords ? <div className="grid min-h-24 place-items-center rounded-2xl border border-dashed border-stone-200 text-xs text-stone-400">تحتاج صلاحية عرض التقارير لمراجعة تسجيلات المكالمات.</div> : sessions.length ? sessions.map((session) => <RecordingReview key={session.id} session={session} canManage={canManage} hiding={hidingId === session.id} onSaved={savedReview} onDeleted={deletedRecording} onHidden={(id) => void hideSession(id)}/>) : <div className="grid min-h-32 place-items-center rounded-2xl border border-dashed border-stone-200 text-xs text-stone-400">لا توجد مكالمات مسجلة في السجل بعد.</div>}
      </div>
    </section>
  </div>;
}
