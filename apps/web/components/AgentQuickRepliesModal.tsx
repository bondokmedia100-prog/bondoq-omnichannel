"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, Check, ChevronDown, FileText, Image as ImageIcon, ListChecks, Pencil, Trash2, X } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";

type Tag = { id: string; name: string; color: string };
type MediaAsset = { id: string; fileName: string; contentType: string; size: number };
type Reply = { id: string; shortcut: string; title: string; content: string; mediaAsset: MediaAsset | null; tags: { tagId: string; tag: Tag }[] };
type ReplyForm = { shortcut: string; content: string; mediaAssetId: string | null; tagIds: string[] };
const emptyForm: ReplyForm = { shortcut: "", content: "", mediaAssetId: null, tagIds: [] };
const mediaTypes = "image/*,video/*,audio/*,application/pdf,text/plain,.doc,.docx,.xls,.xlsx";

export default function AgentQuickRepliesModal({ onClose, onSaved }: { onClose: () => void; onSaved: (replies: Reply[]) => void }) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [mediaAsset, setMediaAsset] = useState<MediaAsset | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    const [replyRows, tagRows] = await Promise.all([
      api<Reply[]>("/api/agent/quick-replies"),
      api<Tag[]>("/api/customer-tags").catch(() => []),
    ]);
    setReplies(replyRows);
    setTags(tagRows);
    onSaved(replyRows);
  }

  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحميل الردود")); }, []);

  async function upload(fileToUpload: File): Promise<MediaAsset> {
    const token = getToken();
    const response = await fetch(`${API_URL}/api/agent/quick-replies/media`, {
      method: "POST",
      headers: {
        "Content-Type": fileToUpload.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(fileToUpload.name),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: fileToUpload,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `تعذر رفع الملف (${response.status})`);
    return result as MediaAsset;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const shortcutText = form.shortcut.trim().replace(/^\/+/, "");
    if (!/^[\p{L}\p{N}_-]{1,39}$/u.test(shortcutText)) {
      setNotice("اكتب اختصارًا من حروف أو أرقام أو _ أو -، من دون مسافات.");
      return;
    }
    if (!form.content.trim() && !file && !form.mediaAssetId) {
      setNotice("اكتب نص الرسالة أو أرفق ملفًا.");
      return;
    }
    setBusy(true);
    setNotice("");
    let newlyUploadedId = "";
    try {
      let mediaAssetId = form.mediaAssetId;
      if (file) {
        const uploaded = await upload(file);
        mediaAssetId = uploaded.id;
        newlyUploadedId = uploaded.id;
      }
      const payload = {
        shortcut: `/${shortcutText}`,
        content: form.content.trim(),
        mediaAssetId,
        tagIds: form.tagIds,
      };
      if (editingId) await api(`/api/agent/quick-replies/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/api/agent/quick-replies", { method: "POST", body: JSON.stringify(payload) });
      newlyUploadedId = "";
      setEditingId("");
      setForm(emptyForm);
      setMediaAsset(null);
      setFile(null);
      setShowLists(false);
      await load();
      setNotice("تم حفظ الرد السريع.");
    } catch (error) {
      if (newlyUploadedId) await api(`/api/agent/quick-replies/media/${newlyUploadedId}`, { method: "DELETE" }).catch(() => {});
      setNotice(error instanceof Error ? error.message : "تعذر حفظ الرد السريع");
    } finally { setBusy(false); }
  }

  async function remove(reply: Reply) {
    if (!window.confirm(`حذف الرد «${reply.title}»؟`)) return;
    try { await api(`/api/agent/quick-replies/${reply.id}`, { method: "DELETE" }); await load(); setNotice("تم حذف الرد."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف الرد"); }
  }

  function edit(reply: Reply) {
    setEditingId(reply.id);
    setForm({ shortcut: reply.shortcut.replace(/^\/+/, ""), content: reply.content, mediaAssetId: reply.mediaAsset?.id || null, tagIds: reply.tags.map((item) => item.tagId) });
    setMediaAsset(reply.mediaAsset);
    setFile(null);
    setShowLists(false);
    setNotice("");
  }

  function resetForm() {
    setEditingId(""); setForm(emptyForm); setMediaAsset(null); setFile(null); setShowLists(false); setNotice("");
  }

  const attachmentName = file?.name || mediaAsset?.fileName;

  return <div className="fixed inset-0 z-[80] grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="quick-replies-title" dir="rtl" className="panel max-h-[94dvh] w-full max-w-3xl overflow-y-auto rounded-[28px] p-4 sm:p-6" onClick={(event) => event.stopPropagation()}>
      <header className="mb-5 flex items-center justify-between gap-3">
        <button type="button" onClick={onClose} aria-label="إغلاق" className="grid h-11 w-11 place-items-center rounded-full border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"><X size={20} /></button>
        <h2 id="quick-replies-title" className="text-center text-base font-extrabold sm:text-lg">{editingId ? "تعديل رد سريع" : "رد سريع جديد"}</h2>
        <button form="quick-reply-form" type="submit" disabled={busy} aria-label="حفظ الرد السريع" title="حفظ" className="grid h-11 w-11 place-items-center rounded-full bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50">{busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Check size={21} />}</button>
      </header>

      <div className="grid gap-5 md:grid-cols-[.9fr_1.1fr]">
        <form id="quick-reply-form" onSubmit={(event) => void save(event)} className="space-y-4 rounded-2xl bg-stone-50 p-4 sm:p-5">
          <label className="block text-xs font-bold text-stone-600">الاختصار
            <div className="mt-2 flex h-12 items-center rounded-2xl border border-stone-200 bg-white px-4 focus-within:border-emerald-500">
              <span dir="ltr" className="text-sm font-bold text-emerald-700">/</span>
              <input required maxLength={39} value={form.shortcut} onChange={(event) => setForm({ ...form, shortcut: event.target.value })} dir="ltr" placeholder="اختصار" aria-label="الاختصار" className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none" />
            </div>
          </label>

          <label className="block text-xs font-bold text-stone-600">الرسالة
            <div className="mt-2 overflow-hidden rounded-2xl border border-stone-200 bg-white focus-within:border-emerald-500">
              <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} maxLength={2000} rows={5} placeholder="كتابة الرسالة" aria-label="نص الرسالة" className="min-h-32 w-full resize-y px-4 py-3 text-sm leading-6 outline-none placeholder:text-stone-400" />
              <div className="flex items-center justify-between border-t border-stone-100 px-3 py-2">
                <input ref={fileInputRef} type="file" accept={mediaTypes} className="hidden" onChange={(event) => { const selected = event.target.files?.[0] || null; event.target.value = ""; setFile(selected); if (selected) { setMediaAsset(null); setForm({ ...form, mediaAssetId: null }); } }} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-50"><Camera size={18} /> إرفاق الوسائط</button>
                {attachmentName && <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-stone-500"><FileText size={14} className="shrink-0" /><span className="max-w-32 truncate">{attachmentName}</span><button type="button" aria-label="إزالة المرفق" onClick={() => { setFile(null); setMediaAsset(null); setForm({ ...form, mediaAssetId: null }); }} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-red-50 hover:text-red-600"><X size={13} /></button></span>}
              </div>
            </div>
          </label>

          <div className="relative">
            <label className="mb-2 block text-xs font-bold text-stone-600">إضافة تلقائيًا إلى القائمة</label>
            <button type="button" aria-expanded={showLists} onClick={() => setShowLists((shown) => !shown)} className="flex h-12 w-full items-center gap-3 rounded-full border border-stone-200 bg-white px-4 text-right text-sm font-bold text-stone-800 hover:border-emerald-300">
              <ListChecks size={18} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{form.tagIds.length ? `${form.tagIds.length} قائمة محددة` : "القوائم"}</span>
              <ChevronDown size={17} className="shrink-0 text-stone-400" />
            </button>
            {showLists && <div className="absolute inset-x-0 top-full z-20 mt-2 max-h-52 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-xl">
              {tags.length ? tags.map((tag) => <label key={tag.id} className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-xs hover:bg-stone-50"><input type="checkbox" checked={form.tagIds.includes(tag.id)} onChange={(event) => setForm({ ...form, tagIds: event.target.checked ? [...form.tagIds, tag.id] : form.tagIds.filter((id) => id !== tag.id) })} className="h-4 w-4 accent-emerald-700" /><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} /><span className="min-w-0 flex-1 truncate">{tag.name}</span></label>) : <p className="px-3 py-4 text-center text-xs leading-5 text-stone-400">لا توجد قوائم متاحة. أنشئ وسوم العملاء من صفحة جهات الاتصال أولًا.</p>}
            </div>}
            <p className="mt-2 text-[10px] leading-5 text-stone-500">اختر القوائم التي ستُضاف إليها المحادثة تلقائيًا عند إرسال هذا الرد السريع.</p>
          </div>

          {notice && <p role="status" className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">{notice}</p>}
          {editingId && <button type="button" onClick={resetForm} className="h-10 w-full rounded-xl bg-white text-xs font-bold text-stone-500 hover:bg-stone-100">إلغاء التعديل</button>}
        </form>

        <div className="min-h-0 space-y-3">
          <h3 className="text-sm font-extrabold">الردود ({replies.length})</h3>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto md:max-h-[70vh]">
            {replies.map((reply) => <article key={reply.id} className="rounded-2xl border border-stone-100 bg-white p-3">
              <div className="flex items-center gap-2">
                <code dir="ltr" className="rounded-lg bg-emerald-50 px-2 py-1 text-[10px] text-emerald-800">{reply.shortcut}</code>
                <b className="min-w-0 flex-1 truncate text-xs">{reply.title}</b>
                {reply.mediaAsset && <span title={reply.mediaAsset.fileName}><ImageIcon size={14} className="shrink-0 text-stone-400" /></span>}
                <button type="button" onClick={() => edit(reply)} aria-label="تعديل" className="rounded-lg p-2 text-stone-400 hover:bg-amber-50 hover:text-amber-800"><Pencil size={14} /></button>
                <button type="button" onClick={() => void remove(reply)} aria-label="حذف" className="rounded-lg p-2 text-stone-400 hover:bg-red-50 hover:text-red-700"><Trash2 size={14} /></button>
              </div>
              {reply.content && <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-stone-600">{reply.content}</p>}
              {reply.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{reply.tags.map(({ tagId, tag }) => <span key={tagId} className="rounded-full px-2 py-1 text-[9px]" style={{ backgroundColor: `${tag.color}18`, color: tag.color }}>{tag.name}</span>)}</div>}
            </article>)}
            {!replies.length && <p className="rounded-2xl bg-stone-50 p-6 text-center text-xs text-stone-400">لا توجد ردود سريعة بعد.</p>}
          </div>
        </div>
      </div>
    </section>
  </div>;
}
