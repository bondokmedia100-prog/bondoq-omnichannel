"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export default function InstallAppButton() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", capture);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);
  if (!prompt) return null;
  return <button type="button" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }} className="hidden items-center gap-1 rounded-lg bg-[#fff8e9] px-2.5 py-2 text-[10px] font-bold text-[#9b7219] sm:flex" title="تثبيت مركز بندق كتطبيق">
    <Download size={14} /> تثبيت التطبيق
  </button>;
}
