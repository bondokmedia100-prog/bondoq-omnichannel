"use client";

import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api";

type UserProfile = Record<string, any>;

export default function AccountSettingsModal({ user, onClose, onSaved }: { user: UserProfile; onClose: () => void; onSaved: (user: UserProfile) => void }) {
  const [username, setUsername] = useState(user.username || "");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const updated = await api<UserProfile>("/api/auth/me", { method: "PATCH", body: JSON.stringify({ username }) });
      onSaved(updated); setUsername(updated.username); setNotice("تم تحديث اسم المستخدم. استخدمه في تسجيل الدخول القادم.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث اسم المستخدم"); }
    finally { setSaving(false); }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/45 p-4 backdrop-blur-sm" onClick={onClose}>
    <section className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
      <div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-bold text-[#bd8d22]">إعدادات الحساب</p><h2 className="mt-1 text-xl font-extrabold">اسم المستخدم</h2><p className="mt-1 text-xs text-stone-500">{user.name} · {user.email}</p></div><button onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18} /></button></div>
      <form onSubmit={save} className="space-y-4">
        <label className="block text-xs font-bold text-stone-600">اسم المستخدم الجديد<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-normal outline-none focus:border-amber-400" dir="ltr" autoComplete="username" /><span className="mt-1 block text-[10px] font-normal text-stone-400">3 إلى 32 حرفًا إنجليزيًا أو رقمًا، ويمكن استخدام النقطة والشرطة.</span></label>
        <button disabled={saving || username === user.username} className="h-11 w-full rounded-xl bg-[#d32f2f] text-sm font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ..." : "حفظ الاسم"}</button>
      </form>
      {notice && <p className={`mt-4 rounded-xl px-3 py-2 text-xs ${notice.startsWith("تم") ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{notice}</p>}
    </section>
  </div>;
}
