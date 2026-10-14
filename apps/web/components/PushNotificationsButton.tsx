"use client";

import { useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { api } from "@/lib/api";

function decodeVapidKey(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

export default function PushNotificationsButton() {
  const [supported, setSupported] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    const initialize = async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
      setSupported(true);
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        const settings = await api<{ configured: boolean; subscribed: boolean }>("/api/push/config");
        const subscription = await registration.pushManager.getSubscription();
        if (current) { setConfigured(settings.configured); setEnabled(Boolean(settings.subscribed && subscription)); }
      } catch { if (current) setNotice("تعذر تحميل حالة إشعارات الجهاز."); }
    };
    void initialize();
    return () => { current = false; };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      if (!supported) throw new Error("الإشعارات غير مدعومة في هذا المتصفح.");
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (enabled && existing) {
        await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: existing.endpoint }) });
        await existing.unsubscribe();
        setEnabled(false);
        setNotice("أُوقفت إشعارات هذا الجهاز.");
        return;
      }
      if (Notification.permission === "denied") throw new Error("إذن الإشعارات مرفوض من إعدادات المتصفح.");
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("لم يُمنح إذن الإشعارات.");
      const settings = await api<{ configured: boolean; publicKey: string }>("/api/push/config");
      setConfigured(settings.configured);
      if (!settings.configured) throw new Error("يلزم تفعيل مفاتيح الإشعارات على الخادم أولًا.");
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(settings.publicKey) });
      await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription) });
      setEnabled(true);
      setNotice("أصبحت إشعارات الرسائل مفعّلة على هذا الجهاز.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر تحديث إعداد الإشعارات.");
    } finally { setBusy(false); }
  }

  const label = !supported ? "إشعارات غير مدعومة" : enabled ? "إيقاف إشعارات الرسائل" : configured ? "تفعيل إشعارات الرسائل" : "مفاتيح إشعارات الخادم غير مهيأة";
  return <div className="relative">
    <button type="button" onClick={() => void toggle()} disabled={!supported || busy} aria-label={label} title={label} className={`grid h-9 w-9 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100"}`}>
      {enabled ? <BellRing size={17} /> : <Bell size={17} />}
    </button>
    {notice && <div role="status" className="absolute left-0 top-11 z-50 w-64 rounded-xl border border-stone-200 bg-white p-3 text-[11px] leading-5 text-stone-700 shadow-xl">{notice}</div>}
  </div>;
}
