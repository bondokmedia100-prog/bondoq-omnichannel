"use client";

import { usePathname } from "next/navigation";

export default function DeveloperCredit({ className = "", showOnLogin = false }: { className?: string; showOnLogin?: boolean }) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin") || pathname === "/login" && !showOnLogin) return null;

  return <footer dir="rtl" className={`mx-auto flex w-full flex-nowrap items-center justify-center gap-x-1 whitespace-nowrap px-1 py-4 text-[8px] text-stone-400 sm:flex-wrap sm:gap-x-4 sm:gap-y-2 sm:px-4 sm:text-[10px] ${className}`}>
    <span className="shrink-0 whitespace-nowrap">حلواني بندق © 2026 · حقوق البرمجة م/ محمود سلامة</span>
    <a href="tel:+201018040600" className="shrink-0 whitespace-nowrap font-semibold text-stone-600 hover:text-amber-800">اتصال مباشر 01018040600</a>
    <a href="https://wa.me/201018040600" target="_blank" rel="noreferrer" className="shrink-0 whitespace-nowrap font-semibold text-emerald-700 hover:text-emerald-800">مراسلة واتساب</a>
  </footer>;
}
