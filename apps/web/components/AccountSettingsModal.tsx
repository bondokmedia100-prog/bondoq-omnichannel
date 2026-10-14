"use client";

import { useState, type FormEvent } from "react";
import { LockKeyhole, X } from "lucide-react";
import { api } from "@/lib/api";

type UserProfile = Record<string, any>;

export default function AccountSettingsModal({ user, onClose, onSaved }: { user: UserProfile; onClose: () => void; onSaved: (user: UserProfile) => void }) {
  const [username, setUsername] = useState(user.username || "");
  const [name, setName] = useState(user.name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const updated = await api<UserProfile>("/api/auth/me", { method: "PATCH", body: JSON.stringify({ username: username.trim(), name: name.trim() }) });
      onSaved({ ...user, ...updated }); setUsername(updated.username); setName(updated.name); setNotice("تم تحديث بيانات الحساب.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث بيانات الحساب"); }
    finally { setSaving(false); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setNotice("");
    if (newPassword !== confirmPassword) { setNotice("كلمتا المرور الجديدتان غير متطابقتين."); return; }
    setSaving(true);
    try {
      await api("/api/auth/me/password", { method: "PATCH", body: JSON.stringify({ currentPassword, newPassword }) });
      localStorage.removeItem("bondoq_token");
      window.location.assign("/login");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تغيير كلمة المرور"); }
    finally { setSaving(false); }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-stone-900/45 p-4 backdrop-blur-sm" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="account-title" className="panel my-auto w-full max-w-lg p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
      <div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-bold text-[#bd8d22]">إعدادات الحساب</p><h2 id="account-title" className="mt-1 text-xl font-extrabold">الملف الشخصي والأمان</h2><p className="mt-1 text-xs text-stone-500">{user.email}</p></div><button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18} /></button></div>
      <form onSubmit={saveProfile} className="space-y-3 rounded-2xl border border-stone-100 bg-white p-4">
        <h3 className="text-sm font-extrabold">بيانات الحساب</h3>
        <label className="block text-xs font-bold text-stone-600">الاسم الظاهر<input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal outline-none focus:border-amber-400" /></label>
        <label className="block text-xs font-bold text-stone-600">اسم المستخدم<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal outline-none focus:border-amber-400" dir="ltr" autoComplete="username" /><span className="mt-1 block text-[10px] font-normal text-stone-400">3 إلى 32 حرفًا إنجليزيًا أو رقمًا، ويمكن استخدام النقطة والشرطة.</span></label>
        <button disabled={saving || (username === user.username && name === user.name)} className="h-10 w-full rounded-xl bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-50">حفظ بيانات الحساب</button>
      </form>
      <form onSubmit={changePassword} className="mt-4 space-y-3 rounded-2xl border border-stone-100 bg-[#faf9f7] p-4">
        <h3 className="flex items-center gap-2 text-sm font-extrabold"><LockKeyhole size={16} /> تغيير كلمة المرور</h3>
        <label className="block text-xs font-bold text-stone-600">كلمة المرور الحالية<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-normal outline-none focus:border-amber-400" /></label>
        <label className="block text-xs font-bold text-stone-600">كلمة المرور الجديدة<input required type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-normal outline-none focus:border-amber-400" /><span className="mt-1 block text-[10px] font-normal text-stone-400">12 حرفًا على الأقل. ستحتاج إلى تسجيل الدخول مجددًا بعد التغيير.</span></label>
        <label className="block text-xs font-bold text-stone-600">تأكيد كلمة المرور<input required type="password" minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-normal outline-none focus:border-amber-400" /></label>
        <button disabled={saving} className="h-10 w-full rounded-xl border border-stone-200 bg-white text-xs font-bold text-stone-700 disabled:opacity-50">{saving ? "جارٍ الحفظ..." : "تغيير كلمة المرور"}</button>
      </form>
      {notice && <p role="status" className={`mt-4 rounded-xl px-3 py-2 text-xs ${notice.startsWith("تم") ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{notice}</p>}
    </section>
  </div>;
}
