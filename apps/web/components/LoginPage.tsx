"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail, MessageCircleMore, ShieldCheck, Sparkles } from "lucide-react";
import { API_URL } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "تعذر تسجيل الدخول");
      localStorage.setItem("bondoq_token", body.token);
      router.replace(body.user.role === "AGENT" || body.user.role === "BRANCH_USER" ? "/agent/workspace" : "/admin/dashboard");
    } catch (err) { setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع"); }
    finally { setBusy(false); }
  }

  return <main className="relative grid min-h-screen overflow-hidden bg-[#fffaf3] px-5 py-10 lg:grid-cols-[1.05fr_.95fr] lg:px-0">
    <div className="pointer-events-none absolute -right-24 -top-32 h-[440px] w-[440px] rounded-full bg-[#ffedc2]/55 blur-3xl" />
    <section className="relative hidden flex-col justify-between overflow-hidden bg-[#bd2528] px-14 py-12 text-white lg:flex xl:px-24">
      <div className="absolute -left-28 bottom-[-150px] h-[540px] w-[540px] rounded-full border border-white/10" />
      <div className="absolute -left-12 bottom-[-108px] h-[420px] w-[420px] rounded-full border border-white/10" />
      <Brand inverse />
      <div className="relative max-w-xl pb-10">
        <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs"><Sparkles size={14} className="text-[#ffd56b]" /> مركزك الموحد لكل محادثة</span>
        <h1 className="text-5xl font-extrabold leading-[1.45] xl:text-6xl">الاهتمام<br /><span className="text-[#ffda78]">يبدأ من هنا.</span></h1>
        <p className="mt-5 max-w-md text-lg leading-8 text-white/75">مساحة عمل واحدة تجمع أحاديث ضيوفنا، وتمنح فريقنا وقتًا أطول لصناعة لحظات حلوة.</p>
        <div className="mt-10 flex items-center gap-3 text-sm text-white/65"><div className="flex -space-x-2 space-x-reverse">{["أ", "س", "م"].map((x, i) => <span key={x} className={`grid h-9 w-9 place-items-center rounded-full border-2 border-[#bd2528] ${["bg-amber-300", "bg-rose-200", "bg-orange-200"][i]} font-bold text-[#612a20]`}>{x}</span>)}</div><span>فريق بندق جاهز لخدمتكم</span></div>
      </div>
      <div className="relative flex items-center justify-between border-t border-white/15 pt-5 text-xs text-white/50"><span>حلواني بندق © 2026</span><span className="flex items-center gap-2"><ShieldCheck size={14} /> بيئة عمل آمنة</span></div>
    </section>

    <section className="relative grid place-items-center py-5 lg:px-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-10 lg:hidden"><Brand /></div>
        <div className="mb-9">
          <p className="mb-2 text-sm font-semibold text-[#c28e22]">مرحبًا بعودتك</p>
          <h2 className="text-3xl font-extrabold tracking-tight text-[#2d2522]">تسجيل الدخول</h2>
          <p className="mt-2 text-sm text-stone-500">أدخل بيانات حسابك للوصول إلى مساحة العمل.</p>
        </div>
        <form onSubmit={submit} className="space-y-5">
          <label className="block"><span className="mb-2 block text-sm font-bold text-stone-700">البريد الإلكتروني أو اسم المستخدم</span><span className="flex h-13 items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 focus-within:border-[#d32f2f] focus-within:ring-4 focus-within:ring-red-50"><Mail size={18} className="text-stone-400" /><input autoComplete="username" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="name@bondoq.com" className="h-full w-full border-0 bg-transparent text-sm outline-none placeholder:text-stone-300" /></span></label>
          <label className="block"><span className="mb-2 block text-sm font-bold text-stone-700">كلمة المرور</span><span className="flex h-13 items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 focus-within:border-[#d32f2f] focus-within:ring-4 focus-within:ring-red-50"><LockKeyhole size={18} className="text-stone-400" /><input autoComplete="current-password" required type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" className="h-full w-full border-0 bg-transparent text-sm outline-none placeholder:text-stone-300" /><button type="button" onClick={() => setShowPassword(!showPassword)} className="text-stone-400">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
          <div className="-mt-2 flex justify-end"><Link href="/forgot-password" className="text-xs font-bold text-[#a87415] hover:underline">نسيت كلمة المرور؟</Link></div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button disabled={busy} className="flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-[#d32f2f] font-bold text-white shadow-lg shadow-red-200/60 transition hover:bg-[#b71c1c] disabled:opacity-60">{busy ? "جارٍ التحقق..." : "دخول إلى مساحة العمل"}<ArrowLeft size={17} /></button>
        </form>
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-[#f2e6cb] bg-[#fff9eb] p-4 text-xs leading-6 text-[#75634c]"><MessageCircleMore size={17} className="mt-1 shrink-0 text-[#d49b22]" /><p>يتم توجيه كل عضو تلقائيًا إلى مساحة العمل المناسبة حسب صلاحيات حسابه.</p></div>
        <p className="mt-8 text-center text-xs text-stone-400">مخصص لفريق حلواني بندق</p>
      </div>
    </section>
  </main>;
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#ffc107] text-2xl font-black text-[#9f2024] shadow-md">ب</div><div><p className={`text-xl font-extrabold ${inverse ? "text-white" : "text-[#2d2522]"}`}>حلواني بندق</p><p className={`text-[10px] ${inverse ? "text-white/55" : "text-stone-400"}`}>حلويات تصنع لحظات جميلة</p></div></div>;
}
