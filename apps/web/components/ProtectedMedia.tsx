"use client";

import { useEffect, useState } from "react";
import { API_URL, getToken } from "@/lib/api";

type AnyRecord = Record<string, any>;

export default function ProtectedMedia({ conversationId, message, onOpenImage }: { conversationId: string; message: AnyRecord; onOpenImage?: (url: string) => void }) {
  const publicUrl = typeof message.mediaUrl === "string" && message.mediaUrl.includes("/public-media/") ? message.mediaUrl : "";
  const [source, setSource] = useState("");
  const [useProtected, setUseProtected] = useState(!publicUrl);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let objectUrl = "";
    let disposed = false;
    setError(false);
    setSource("");
    if (publicUrl && !useProtected) {
      setSource(publicUrl);
      return () => {};
    }
    const controller = new AbortController();
    fetch(`${API_URL}/api/conversations/${conversationId}/messages/${message.id}/media`, {
      headers: { Authorization: `Bearer ${getToken()}` }, signal: controller.signal
    }).then((response) => response.ok ? response.blob() : Promise.reject(new Error("تعذر تحميل المرفق")))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) URL.revokeObjectURL(objectUrl);
        else setSource(objectUrl);
      }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attempt, conversationId, message.id, publicUrl, useProtected]);

  if (error) return <span className="mb-2 flex items-center gap-2 text-[10px] text-red-700">تعذر تحميل المرفق <button type="button" onClick={() => { setError(false); setUseProtected(true); setAttempt((value) => value + 1); }} className="underline">إعادة المحاولة</button></span>;
  if (!source) return <span className="mb-2 block text-[10px] text-stone-400">جارٍ تحميل المرفق...</span>;
  if (message.kind === "IMAGE" || message.kind === "STICKER") return <button type="button" onClick={() => onOpenImage?.(source)} className="mb-2 block" aria-label="تكبير الصورة"><img src={source} alt={message.kind === "STICKER" ? "ملصق" : "صورة من العميل"} onError={() => { if (publicUrl && !useProtected) setUseProtected(true); else setError(true); }} className={`max-h-72 max-w-full rounded-xl ${message.kind === "STICKER" ? "object-contain" : "object-contain"}`} /></button>;
  if (message.kind === "AUDIO") return <audio controls src={source} className="mb-2 max-w-full" />;
  if (message.kind === "VIDEO") return <video controls src={source} className="mb-2 max-h-72 max-w-full rounded-xl" />;
  return <a href={source} download className="mb-2 block text-xs font-bold text-blue-700 underline">تنزيل الملف المرفق</a>;
}
