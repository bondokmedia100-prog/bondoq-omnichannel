"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";

type Reply = { id: string; shortcut: string; title: string; content: string };
const emptyForm = { shortcut: "/", title: "", content: "" };

export default function AgentQuickRepliesModal({ onClose, onSaved }: { onClose: () => void; onSaved: (replies: Reply[]) => void }) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    const result = await api<Reply[]>("/api/agent/quick-replies");
    setReplies(result);
    onSaved(result);
  }

  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحميل الردود")); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      if (editingId) await api(`/api/agent/quick-replies/${editingId}`, { method: "PATCH", body: JSON.stringify(form) });
      else await api("/api/agent/quick-replies", { method: "POST", body: JSON.stringify(form) });
      setForm(emptyForm); setEditingId(""); await load(); setNotice("تم حفظ الرد السريع.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الرد السريع"); }
    finally { setBusy(false); }
  }

  async function remove(reply: Reply) {
    if (!window.confirm(`حذف الرد «${reply.title}»؟`)) return;
    try { await api(`/api/agent/quick-replies/${reply.id}`, { method: "DELETE" }); await load(); setNotice("تم حذف الرد."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف الرد"); }
  }

  return <div className="fixed inset-0 z-[80] grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="quick-replies-title" className="panel max-h-[90vh] w-full max-w-3xl overflow-y-auto p-5" onClick={(event) => event.stopPropagation()}>
      <header className="mb-4 flex items-start justify-between gap-3"><div><h2 id="quick-replies-title" className="text-base font-extrabold">ردودي السريعة</h2><p className="mt-1 text-xs text-stone-500">هذه الردود خاصة بحسابك، ولا تغيّر الردود المشتركة.</p></div><button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-lg p-1 text-stone-400"><X size={18} /></button></header>
      <div className="grid gap-4 md:grid-cols-[.85fr_1.15fr]">
        <form onSubmit={(event) => void save(event)} className="space-y-3 rounded-2xl bg-stone-50 p-4"><h3 className="text-xs font-extrabold">{editingId ? "تعديل الرد" : "إضافة رد"}</h3><input required maxLength={40} pattern="/[\p{L}\p{N}_-]+" value={form.shortcut} onChange={(event) => setForm({ ...form, shortcut: event.target.value })} dir="ltr" placeholder="/اختصار" className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs" /><input required minLength={2} maxLength={80} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="عنوان الرد" className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs" /><textarea required maxLength={2000} rows={5} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="محتوى الرد" className="w-full rounded-xl border border-stone-200 px-3 py-2 text-xs leading-6" /><button disabled={busy} className="h-10 w-full rounded-xl bg-emerald-700 text-xs font-bold text-white disabled:opacity-50">{busy ? "جارٍ الحفظ..." : editingId ? "حفظ التعديل" : "إضافة الرد"}</button>{editingId && <button type="button" onClick={() => { setEditingId(""); setForm(emptyForm); }} className="h-9 w-full rounded-xl bg-white text-xs font-bold text-stone-500">إلغاء التعديل</button>}</form>
        <div className="space-y-2"><h3 className="text-xs font-extrabold">الردود ({replies.length})</h3>{replies.map((reply) => <article key={reply.id} className="rounded-xl border border-stone-100 p-3"><div className="flex items-center gap-2"><code dir="ltr" className="rounded bg-emerald-50 px-2 py-1 text-[10px] text-emerald-800">{reply.shortcut}</code><b className="min-w-0 flex-1 truncate text-xs">{reply.title}</b><button type="button" onClick={() => { setEditingId(reply.id); setForm({ shortcut: reply.shortcut, title: reply.title, content: reply.content }); }} aria-label="تعديل" className="rounded-lg p-2 text-stone-400 hover:bg-amber-50 hover:text-amber-800"><Pencil size={14} /></button><button type="button" onClick={() => void remove(reply)} aria-label="حذف" className="rounded-lg p-2 text-stone-400 hover:bg-red-50 hover:text-red-700"><Trash2 size={14} /></button></div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-stone-600">{reply.content}</p></article>)}{!replies.length && <p className="rounded-xl bg-stone-50 p-6 text-center text-xs text-stone-400">لا توجد ردود شخصية بعد.</p>}</div>
      </div>
      {notice && <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{notice}</p>}
    </section>
  </div>;
}
