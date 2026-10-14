"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!localStorage.getItem("bondoq_token")) return router.replace("/login");
    let current = true;
    api("/api/auth/me").then((user) => router.replace(user.role === "AGENT" || user.role === "BRANCH_USER" ? "/agent/workspace" : "/admin/dashboard")).catch((reason) => {
      if (!current) return;
      if (reason instanceof ApiError && reason.status === 401) {
        localStorage.removeItem("bondoq_token");
        router.replace("/login");
        return;
      }
      setError("تعذر الاتصال بالخادم. بقي تسجيل الدخول محفوظًا؛ أعد المحاولة عند عودة الاتصال.");
    });
    return () => { current = false; };
  }, [attempt, router]);
  return <main className="grid min-h-screen place-items-center text-sm text-stone-500">{error ? <div className="mx-5 max-w-md text-center"><p role="status">{error}</p><button type="button" onClick={() => { setError(""); setAttempt((value) => value + 1); }} className="mt-4 rounded-xl bg-[#d32f2f] px-4 py-2 font-bold text-white">إعادة المحاولة</button></div> : "جارٍ فتح مساحة العمل..."}</main>;
}
