"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

export default function ApprovePasswordResetPage() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") || ""); }, []);

  async function approve() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${API_URL}/api/auth/password-reset/approve-by-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "تعذر اعتماد الطلب.");
      setMessage(body.message || "تم اعتماد الطلب وإرسال رابط التغيير."); setApproved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر اعتماد الطلب.");
    } finally { setBusy(false); }
  }

  return <main dir="rtl" className="grid min-h-screen place-items-center bg-[#fffaf3] px-5 py-10">
    <section className="w-full max-w-md rounded-3xl border border-stone-100 bg-white p-7 shadow-xl shadow-stone-200/50 sm:p-9">
      <div className="mb-8 flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#ffc107] text-2xl font-black text-[#9f2024]">ب</div><div><p className="text-lg font-extrabold text-[#2d2522]">حلواني بندق</p><p className="text-[10px] text-stone-400">موافقة استعادة الحساب</p></div></div>
      <p className="text-sm font-semibold text-[#c28e22]">تحقق من الطلب</p>
      <h1 className="mt-2 text-2xl font-extrabold text-[#2d2522]">اعتماد إعادة ضبط كلمة المرور</h1>
      <p className="mt-3 text-sm leading-7 text-stone-500">بالضغط على الموافقة، سيتم إرسال رسالة ثانية إلى صندوق الاستعادة، تحتوي على رابط تغيير صالح لمدة 30 دقيقة ويُستخدم مرة واحدة.</p>
      <p dir="ltr" className="mt-3 rounded-xl bg-[#fff9eb] px-4 py-3 text-left text-xs font-bold text-[#75634c]">mahmoudsalamagsm@gmail.com</p>
      {!token && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">رابط الموافقة غير مكتمل. أعد فتح الرابط من رسالة البريد.</p>}
      {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {approved && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{message}</p>}
      {!approved && <button type="button" disabled={!token || busy} onClick={() => void approve()} className="mt-6 h-12 w-full rounded-xl bg-[#d32f2f] text-sm font-bold text-white transition hover:bg-[#b71c1c] disabled:opacity-50">{busy ? "جارٍ اعتماد الطلب..." : "أوافق وأرسل رابط تغيير كلمة المرور"}</button>}
      <Link href="/login" className="mt-6 block text-center text-sm font-bold text-stone-500 hover:text-[#a87415]">إلغاء والعودة لتسجيل الدخول</Link>
    </section>
  </main>;
}
