"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    if (!localStorage.getItem("bondoq_token")) return router.replace("/login");
    api("/api/auth/me").then((user) => router.replace(user.role === "AGENT" ? "/agent/workspace" : "/admin/dashboard")).catch(() => {
      localStorage.removeItem("bondoq_token"); router.replace("/login");
    });
  }, [router]);
  return <main className="grid min-h-screen place-items-center text-sm text-stone-500">جارٍ فتح مساحة العمل...</main>;
}
