"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, MessageCircle, Send, X } from "lucide-react";
import { API_URL, api } from "@/lib/api";

type AnyRecord = Record<string, any>;

export function MessengerSettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AnyRecord | null>(null);
  const [form, setForm] = useState({ pageId: "", pageAccessToken: "", appSecret: "", verifyToken: "" });
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => { api("/api/admin/integrations/messenger").then((value) => { setSettings(value); setForm((old) => ({ ...old, pageId: value.pageId || "" })); }).catch((error) => setNotice(error.message)); }, []);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const result = await api("/api/admin/integrations/messenger", { method: "PUT", body: JSON.stringify(form) });
      setSettings(result); setForm((old) => ({ ...old, pageId: result.pageId || "", pageAccessToken: "", appSecret: "", verifyToken: "" }));
      setNotice("حُفظت الأسرار مشفّرة. أدخل الحقول الفارغة لتغيير السر فقط.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الإعدادات"); }
    finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setNotice("");
    try { const result = await api("/api/admin/integrations/messenger/test", { method: "POST" }); setSettings((old) => ({ ...old, pageId: result.pageId, pageTokenConfigured: true })); setForm((old) => ({ ...old, pageId: result.pageId || "" })); setNotice(`تم الاتصال بصفحة ${result.pageName || result.pageId}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "فشل اختبار الاتصال"); }
    finally { setTesting(false); }
  }

  return <ModalShell title="إعداد Messenger" subtitle="اربط صفحة Facebook لتشغيل الرسائل الواردة والصادرة." icon={<MessageCircle size={19} />} color="text-blue-700" onClose={onClose} notice={notice}>
    <div className="grid gap-4 lg:grid-cols-[1fr_.86fr]">
      <form onSubmit={save} className="space-y-3 rounded-2xl bg-stone-50 p-4">
        <TextField label="معرّف صفحة Facebook" value={form.pageId} onChange={(pageId) => setForm({ ...form, pageId })} placeholder="يُكتشف عند اختبار الرمز" />
        <TextField label="Page Access Token" secret configured={settings?.pageTokenConfigured} value={form.pageAccessToken} onChange={(pageAccessToken) => setForm({ ...form, pageAccessToken })} />
        <TextField label="Meta App Secret" secret configured={settings?.appSecretConfigured} value={form.appSecret} onChange={(appSecret) => setForm({ ...form, appSecret })} />
        <TextField label="Webhook Verify Token" secret configured={settings?.verifyTokenConfigured} value={form.verifyToken} onChange={(verifyToken) => setForm({ ...form, verifyToken })} />
        <button disabled={saving || !settings} className="h-10 w-full rounded-xl bg-blue-700 text-xs font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ..." : "حفظ إعدادات Messenger"}</button>
        <button type="button" disabled={testing || !settings?.pageTokenConfigured} onClick={test} className="h-10 w-full rounded-xl border border-blue-200 bg-white text-xs font-bold text-blue-800 disabled:opacity-50">{testing ? "جارٍ التحقق..." : "اختبار رمز الصفحة"}</button>
      </form>
      <WebhookInfo title="إعداد Webhook في Meta" url={`${API_URL}/webhooks/meta`}>
        <p>ضع Verify Token نفسه هنا في لوحة Meta، واشترك في أحداث الصفحة <code>messages</code> و<code>messaging_postbacks</code>. لا تشارك الأسرار في المحادثات.</p>
        <StatusLine label="رمز الصفحة" ready={settings?.pageTokenConfigured} />
        <StatusLine label="App Secret للتحقق من التوقيع" ready={settings?.appSecretConfigured} />
        <StatusLine label="Verify Token للتحقق من Webhook" ready={settings?.verifyTokenConfigured} />
      </WebhookInfo>
    </div>
  </ModalShell>;
}

export function TelegramSettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AnyRecord | null>(null);
  const [form, setForm] = useState({ botUsername: "", botToken: "", webhookSecret: "" });
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  useEffect(() => { api("/api/admin/integrations/telegram").then((value) => { setSettings(value); setForm((old) => ({ ...old, botUsername: value.botUsername || "" })); }).catch((error) => setNotice(error.message)); }, []);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const result = await api("/api/admin/integrations/telegram", { method: "PUT", body: JSON.stringify(form) });
      setSettings(result); setForm((old) => ({ ...old, botUsername: result.botUsername || "", botToken: "", webhookSecret: "" }));
      setNotice("حُفظت أسرار البوت مشفّرة. أدخل الحقول الفارغة لتغيير السر فقط.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الإعدادات"); }
    finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setNotice("");
    try { const result = await api("/api/admin/integrations/telegram/test", { method: "POST" }); setForm((old) => ({ ...old, botUsername: result.botUsername || "" })); setSettings((old) => ({ ...old, botUsername: result.botUsername, botTokenConfigured: true })); setNotice(`تم الاتصال بالبوت @${result.botUsername}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "فشل اختبار الاتصال"); }
    finally { setTesting(false); }
  }
  async function configureWebhook() {
    setConfiguring(true); setNotice("");
    try { await api("/api/admin/integrations/telegram/webhook", { method: "POST", body: JSON.stringify({ url: `${API_URL}/webhooks/telegram` }) }); setNotice("تم تسجيل Webhook لدى Telegram."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تسجيل Webhook"); }
    finally { setConfiguring(false); }
  }

  return <ModalShell title="إعداد Telegram" subtitle="اربط بوت Telegram لتشغيل استقبال الرسائل والرد عليها." icon={<Send size={18} />} color="text-sky-700" onClose={onClose} notice={notice}>
    <div className="grid gap-4 lg:grid-cols-[1fr_.86fr]">
      <form onSubmit={save} className="space-y-3 rounded-2xl bg-stone-50 p-4">
        <TextField label="اسم البوت" value={form.botUsername} onChange={(botUsername) => setForm({ ...form, botUsername })} placeholder="بدون علامة @" />
        <TextField label="Bot Token من BotFather" secret configured={settings?.botTokenConfigured} value={form.botToken} onChange={(botToken) => setForm({ ...form, botToken })} />
        <TextField label="رمز حماية Webhook" secret configured={settings?.webhookSecretConfigured} value={form.webhookSecret} onChange={(webhookSecret) => setForm({ ...form, webhookSecret })} placeholder="16 حرفًا أو أكثر" />
        <button disabled={saving || !settings} className="h-10 w-full rounded-xl bg-sky-700 text-xs font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ..." : "حفظ إعدادات Telegram"}</button>
        <button type="button" disabled={testing || !settings?.botTokenConfigured} onClick={test} className="h-10 w-full rounded-xl border border-sky-200 bg-white text-xs font-bold text-sky-800 disabled:opacity-50">{testing ? "جارٍ التحقق..." : "اختبار رمز البوت"}</button>
      </form>
      <WebhookInfo title="Webhook الوارد" url={`${API_URL}/webhooks/telegram`}>
        <p>أنشئ رمز حماية عشوائيًا، واحفظه ثم اضغط تسجيل Webhook. يتصل الخادم بـ Telegram لتسجيل العنوان والرمز.</p>
        <StatusLine label="رمز البوت" ready={settings?.botTokenConfigured} />
        <StatusLine label="رمز حماية Webhook" ready={settings?.webhookSecretConfigured} />
        <button onClick={configureWebhook} disabled={configuring || !settings?.botTokenConfigured || !settings?.webhookSecretConfigured} className="mt-2 h-10 w-full rounded-xl bg-sky-700 text-xs font-bold text-white disabled:opacity-50">{configuring ? "جارٍ التسجيل..." : "تسجيل Webhook لدى Telegram"}</button>
      </WebhookInfo>
    </div>
  </ModalShell>;
}

function ModalShell({ title, subtitle, icon, color, onClose, notice, children }: { title: string; subtitle: string; icon: ReactNode; color: string; onClose: () => void; notice: string; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/50 p-3 backdrop-blur-sm" onClick={onClose}><section className="panel max-h-[94vh] w-full max-w-4xl overflow-y-auto p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
    <div className="mb-5 flex items-start justify-between gap-4"><div><div className={`mb-1 flex items-center gap-2 text-xs font-bold ${color}`}>{icon} قنوات التواصل</div><h2 className="text-xl font-extrabold">{title}</h2><p className="mt-1 text-xs text-stone-500">{subtitle}</p></div><button onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={19} /></button></div>
    {children}{notice && <p className={`mt-4 rounded-xl px-3 py-2 text-xs ${notice.includes("تعذر") || notice.includes("فشل") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{notice}</p>}
  </section></div>;
}

function TextField({ label, value, onChange, secret, configured, placeholder }: { label: string; value: string; onChange: (value: string) => void; secret?: boolean; configured?: boolean; placeholder?: string }) {
  return <label className="block text-xs font-bold text-stone-600">{label}{secret && configured && <span className="mr-2 text-[10px] text-emerald-700">سر محفوظ</span>}<input type={secret ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder || (secret && configured ? "اتركه فارغًا للإبقاء على السر الحالي" : "")} autoComplete={secret ? "new-password" : "off"} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs font-normal outline-none focus:border-amber-300" dir="ltr" /></label>;
}

function WebhookInfo({ title, url, children }: { title: string; url: string; children: ReactNode }) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | "">("");

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return <div className="space-y-3 rounded-2xl border border-stone-200 bg-white p-4"><h3 className="text-sm font-extrabold">{title}</h3><div className="flex flex-col gap-2 sm:flex-row"><div dir="ltr" className="min-w-0 flex-1 select-all break-all rounded-lg bg-stone-50 px-3 py-2 font-mono text-xs leading-5 text-stone-700">{url}</div><button type="button" onClick={copyUrl} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-700 px-3 text-xs font-bold text-white hover:bg-blue-800" aria-label="نسخ رابط Webhook">{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}{copyState === "copied" ? "تم النسخ" : "نسخ الرابط"}</button></div>{copyState === "failed" && <p className="text-[10px] text-amber-700" role="status">تعذر النسخ تلقائيًا؛ حدّد الرابط أعلاه وانسخه يدويًا.</p>}<div className="space-y-2 text-[10px] leading-5 text-stone-500">{children}</div></div>;
}

function StatusLine({ label, ready }: { label: string; ready?: boolean }) {
  return <p className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 ${ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}><span>{label}</span><b>{ready ? "مضبوط" : "غير مضبوط"}</b></p>;
}
