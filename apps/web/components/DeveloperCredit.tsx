"use client";

import { usePathname } from "next/navigation";

export default function DeveloperCredit({ className = "", showOnLogin = false }: { className?: string; showOnLogin?: boolean }) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin") || pathname === "/login" && !showOnLogin) return null;

  return <footer dir="rtl" className={`mx-auto flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-4 text-[10px] text-stone-400 ${className}`}>
    <span>حلواني بندق © 2026 · حقوق البرمجة م/ محمود سلامة</span>
    <a href="tel:+201018040600" className="font-semibold text-stone-600 hover:text-amber-800">اتصال مباشر 01018040600</a>
    <a href="https://wa.me/201018040600" target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 hover:text-emerald-800">مراسلة واتساب</a>
  </footer>;
}
