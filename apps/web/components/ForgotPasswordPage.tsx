"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { API_URL } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(`${API_URL}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "تعذر إرسال الطلب الآن.");
      setMessage(body.message || "إذا كانت البيانات تخص حسابًا نشطًا، فسيظهر طلب إعادة الضبط للموافقة.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إرسال الطلب الآن.");
    } finally { setBusy(false); }
  }

  return <main dir="rtl" className="grid min-h-screen place-items-center bg-[#fffaf3] px-5 py-10">
    <section className="w-full max-w-md rounded-3xl border border-stone-100 bg-white p-7 shadow-xl shadow-stone-200/50 sm:p-9">
      <div className="mb-8 flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#ffc107] text-2xl font-black text-[#9f2024]">ب</div><div><p className="text-lg font-extrabold text-[#2d2522]">حلواني بندق</p><p className="text-[10px] text-stone-400">استعادة كلمة المرور</p></div></div>
      <p className="text-sm font-semibold text-[#c28e22]">استعادة آمنة لجميع الحسابات</p>
      <h1 className="mt-2 text-2xl font-extrabold text-[#2d2522]">طلب إعادة ضبط كلمة المرور</h1>
      <p className="mt-3 text-sm leading-7 text-stone-500">أدخل البريد المسجّل أو اسم المستخدم. تصل رسالة الموافقة إلى صندوق الاستعادة؛ وبعد تأكيدها تصلك رسالة ثانية برابط تغيير كلمة المرور.</p>
      <p dir="ltr" className="mt-3 rounded-xl bg-[#fff9eb] px-4 py-3 text-left text-xs font-bold text-[#75634c]">mahmoudsalamagsm@gmail.com</p>
      <form onSubmit={submit} className="mt-7 space-y-4">
        <label className="block text-sm font-bold text-stone-700">البريد المسجّل أو اسم المستخدم<input required autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} dir="ltr" className="mt-2 h-12 w-full rounded-xl border border-stone-200 px-4 text-left text-sm outline-none focus:border-[#d32f2f] focus:ring-4 focus:ring-red-50" placeholder="admin@example.com أو username" /></label>
        {message && <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{message}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="h-12 w-full rounded-xl bg-[#d32f2f] text-sm font-bold text-white transition hover:bg-[#b71c1c] disabled:opacity-60">{busy ? "جارٍ إرسال الطلب..." : "إرسال طلب الموافقة"}</button>
      </form>
      <Link href="/login" className="mt-6 block text-center text-sm font-bold text-stone-500 hover:text-[#a87415]">العودة إلى تسجيل الدخول</Link>
    </section>
  </main>;
}
