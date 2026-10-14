"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { API_URL } from "@/lib/api";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") || ""); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage(""); setError("");
    if (newPassword !== confirmPassword) { setError("كلمتا المرور غير متطابقتين."); return; }
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/password-reset/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "تعذر تغيير كلمة المرور.");
      setMessage(body.message || "تم تغيير كلمة المرور."); setCompleted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تغيير كلمة المرور.");
    } finally { setBusy(false); }
  }

  return <main dir="rtl" className="grid min-h-screen place-items-center bg-[#fffaf3] px-5 py-10">
    <section className="w-full max-w-md rounded-3xl border border-stone-100 bg-white p-7 shadow-xl shadow-stone-200/50 sm:p-9">
      <div className="mb-8 flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#ffc107] text-2xl font-black text-[#9f2024]">ب</div><div><p className="text-lg font-extrabold text-[#2d2522]">حلواني بندق</p><p className="text-[10px] text-stone-400">تعيين كلمة مرور جديدة</p></div></div>
      <h1 className="text-2xl font-extrabold text-[#2d2522]">إعادة ضبط كلمة المرور</h1>
      {!token && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">الرابط غير مكتمل. اطلب رابطًا جديدًا من صفحة استعادة كلمة المرور.</p>}
      {token && !completed && <form onSubmit={submit} className="mt-6 space-y-4">
        <p className="text-sm leading-6 text-stone-500">اختر كلمة مرور جديدة لا تقل عن 12 حرفًا. الرابط صالح لمدة 30 دقيقة ويُستخدم مرة واحدة.</p>
        <label className="block text-sm font-bold text-stone-700">كلمة المرور الجديدة<input required minLength={12} maxLength={200} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} dir="ltr" className="mt-2 h-12 w-full rounded-xl border border-stone-200 px-4 text-left text-sm outline-none focus:border-[#d32f2f] focus:ring-4 focus:ring-red-50" /></label>
        <label className="block text-sm font-bold text-stone-700">تأكيد كلمة المرور<input required minLength={12} maxLength={200} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} dir="ltr" className="mt-2 h-12 w-full rounded-xl border border-stone-200 px-4 text-left text-sm outline-none focus:border-[#d32f2f] focus:ring-4 focus:ring-red-50" /></label>
        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="h-12 w-full rounded-xl bg-[#d32f2f] text-sm font-bold text-white transition hover:bg-[#b71c1c] disabled:opacity-60">{busy ? "جارٍ تغيير كلمة المرور..." : "حفظ كلمة المرور الجديدة"}</button>
      </form>}
      {completed && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{message}</p>}
      {error && !token && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <Link href="/login" className="mt-6 block text-center text-sm font-bold text-stone-500 hover:text-[#a87415]">العودة إلى تسجيل الدخول</Link>
    </section>
  </main>;
}
