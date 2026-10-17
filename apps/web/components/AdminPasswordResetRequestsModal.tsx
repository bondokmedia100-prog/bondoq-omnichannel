"use client";

import { useEffect, useState } from "react";
import { Check, Clock3, KeyRound, X } from "lucide-react";
import { api } from "@/lib/api";

type ResetRequest = { id: string; status: "PENDING" | "APPROVED"; requestedAt: string; expiresAt: string | null; user: { id: string; name: string; email: string; username: string; role: string; isActive: boolean } };
const roleNames: Record<string, string> = { ADMIN: "مدير النظام", SUPERVISOR: "قائد فريق", AGENT: "موظف", BRANCH_USER: "موظف" };

export default function AdminPasswordResetRequestsModal({ onClose }: { onClose: () => void }) {
  const [requests, setRequests] = useState<ResetRequest[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");

  async function refresh() {
    setRequests(await api<ResetRequest[]>("/api/admin/password-reset-requests"));
  }

  useEffect(() => { refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "تعذر تحميل الطلبات")); }, []);

  async function review(request: ResetRequest, action: "approve" | "reject") {
    setBusyId(request.id); setError(""); setNotice("");
    try {
      const result = await api<{ message: string }>(`/api/admin/password-reset-requests/${request.id}/${action}`, { method: "POST" });
      setNotice(result.message); await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحديث الطلب");
      await refresh().catch(() => undefined);
    } finally { setBusyId(""); }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-stone-900/45 p-4 backdrop-blur-sm" onClick={onClose}>
    <section dir="rtl" role="dialog" aria-modal="true" aria-labelledby="password-reset-title" className="my-auto w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl sm:p-7" onClick={(event) => event.stopPropagation()}>
      <header className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-[#bd8d22]">مراجعة أمنية</p><h2 id="password-reset-title" className="mt-1 flex items-center gap-2 text-xl font-extrabold"><KeyRound size={19} />طلبات استعادة كلمة المرور</h2><p className="mt-2 text-xs leading-5 text-stone-500">تظهر طلبات جميع الأدوار. يوافق مدير النظام من اللوحة، أو يؤكد الطلب صاحب صندوق الاستعادة الموحد.</p></div><button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18} /></button></header>
      {notice && <p role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {requests.map((request) => <article key={request.id} className="rounded-2xl border border-stone-200 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-extrabold text-stone-800">{request.user.name} <span className="text-[10px] font-semibold text-stone-400">· {roleNames[request.user.role] || request.user.role}</span></p><p dir="ltr" className="mt-1 text-left text-xs text-stone-500">{request.user.email} · {request.user.username}</p><p className="mt-2 flex items-center gap-1 text-[10px] text-stone-400"><Clock3 size={12} />الطلب: {new Date(request.requestedAt).toLocaleString("ar-EG")}</p>{request.status === "APPROVED" && <p className="mt-1 text-[10px] text-amber-700">تمت الموافقة سابقًا{request.expiresAt ? ` · ينتهي ${new Date(request.expiresAt).toLocaleString("ar-EG")}` : ""}</p>}{!request.user.isActive && <p className="mt-1 text-[10px] font-bold text-red-700">الحساب موقوف</p>}</div>
            <div className="flex gap-2"><button type="button" disabled={busyId === request.id || !request.user.isActive} onClick={() => void review(request, "approve")} className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Check size={14} />{busyId === request.id ? "جارٍ التنفيذ..." : request.status === "APPROVED" ? "إعادة إرسال الرابط" : "موافقة وإرسال"}</button><button type="button" disabled={busyId === request.id} onClick={() => void review(request, "reject")} className="rounded-xl border border-stone-200 px-3 py-2 text-xs font-bold text-stone-600 disabled:opacity-50">رفض / إلغاء</button></div>
          </div>
        </article>)}
        {!requests.length && !error && <p className="rounded-2xl bg-stone-50 px-4 py-10 text-center text-sm text-stone-500">لا توجد طلبات معلّقة أو موافَق عليها حاليًا.</p>}
      </div>
    </section>
  </div>;
}
