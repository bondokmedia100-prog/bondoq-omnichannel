"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Activity, Archive, ArrowDown, ArrowDownLeft, ArrowLeft, ArrowUpRight, Bell, CakeSlice, Check, CheckCircle2, Clock3, Copy, FileText, Headset, LogOut, MessageCircle, MoreHorizontal, QrCode, Search, Send, ShieldAlert, UserRound, Users, Volume2, VolumeX, X } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";
import QRCode from "qrcode";
import AccountSettingsModal from "./AccountSettingsModal";
import { MessengerSettingsModal, TelegramSettingsModal } from "./ChannelIntegrationModals";
import PushNotificationsButton from "./PushNotificationsButton";
import InstallAppButton from "./InstallAppButton";
import TeamManagementModal from "./TeamManagementModal";
import { isNotificationSoundEnabled, mergeMessages, messageNotificationPreview, playIncomingMessageTone, setNotificationSoundEnabled } from "@/lib/messageHelpers";

type AnyRecord = Record<string, any>;
const channelLabel: Record<string, string> = { WHATSAPP: "واتساب", MESSENGER: "ماسنجر", TELEGRAM: "تليجرام" };
const deptLabel: Record<string, string> = { CAKES: "مبيعات التورتات", DELIVERY: "طلبات التوصيل", CUSTOMER_CARE: "خدمة العملاء", QUALITY: "قسم الجودة", HEADQUARTERS: "المقر الرئيسي · HQ", WORK_FROM_HOME: "العمل من المنزل · WFH", BRANCH: "مستخدم فرع", ADMINISTRATION: "الإدارة" };
const presenceLabel: Record<string, string> = { ONLINE: "متاح", BUSY: "مشغول", BREAK: "استراحة", OFFLINE: "غير متصل" };
const categoryLabel: Record<string, string> = { EASTERN: "حلويات شرقية", WESTERN: "حلويات غربية", CAKES: "تورتات", BAKERY: "مخبوزات", KAHK: "كحك وبسكويت", CHOCOLATE: "شوكولاتة", MOULID: "حلاوة المولد", OCCASIONS: "مناسبات", MIX_BONDOQ: "ميكس بندق" };

export default function AdminDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<AnyRecord | null>(null);
  const [data, setData] = useState<AnyRecord | null>(null);
  const [conversations, setConversations] = useState<AnyRecord[]>([]);
  const [agents, setAgents] = useState<AnyRecord[]>([]);
  const [branches, setBranches] = useState<AnyRecord[]>([]);
  const [selected, setSelected] = useState<AnyRecord | null>(null);
  const [detail, setDetail] = useState<AnyRecord | null>(null);
  const [whisper, setWhisper] = useState("");
  const [adminReply, setAdminReply] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [csatAlert, setCsatAlert] = useState("");
  const [showStaff, setShowStaff] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const [showAutoReplies, setShowAutoReplies] = useState(false);
  const [showCannedResponses, setShowCannedResponses] = useState(false);
  const [showKalemly, setShowKalemly] = useState(false);
  const [showMessenger, setShowMessenger] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [incomingNotifications, setIncomingNotifications] = useState<AnyRecord[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const detailRequest = useRef(0);
  const detailLoadingIdRef = useRef("");
  const loadingMessagesRef = useRef(new Map<string, AnyRecord[]>());
  const loadRequest = useRef(0);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const notifiedMessagesRef = useRef(new Set<string>());
  const stickToBottom = useRef(true);

  useEffect(() => { setSoundEnabled(isNotificationSoundEnabled()); }, []);
  useEffect(() => {
    if (!selected || !detail || !messageEndRef.current) return;
    if (stickToBottom.current) { messageEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" }); setShowJumpToBottom(false); }
    else setShowJumpToBottom(true);
  }, [selected?.id, detail?.id, detail?.messages?.length]);

  function allowed(profile: AnyRecord | null, permission: string) {
    if (profile?.role === "ADMIN" || profile?.role === "SUPERVISOR") return profile[permission] !== false;
    return profile?.[permission] === true;
  }
  async function load(profile = user) {
    const request = ++loadRequest.current;
    try {
      const [stats, chats, staff, branchList] = await Promise.all([allowed(profile, "canViewReports") ? api("/api/admin/dashboard") : Promise.resolve(null), api("/api/conversations"), api("/api/admin/agents"), api("/api/branches")]);
      if (request === loadRequest.current) { setData(stats); setConversations(chats); setAgents(staff); setBranches(branchList); }
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تحميل لوحة التحكم"); }
  }
  useEffect(() => {
    if (!getToken()) return router.replace("/login");
    let connection: Socket | undefined;
    api("/api/auth/me").then((profile) => {
      if (profile.role === "AGENT" || profile.role === "BRANCH_USER") return router.replace("/agent/workspace");
      setUser(profile); load(profile);
      connection = io(API_URL, { auth: { token: getToken() } });
      setSocket(connection);
      connection.on("connect", () => { void load(profile); });
      connection.on("message:new", (event) => {
        load(profile);
        const conversationId = event.conversationId || event.conversation?.id;
        if (event.message?.direction === "INBOUND" && conversationId) {
          const messageId = event.message.id;
          if (!messageId || !notifiedMessagesRef.current.has(messageId)) {
            if (messageId) {
              notifiedMessagesRef.current.add(messageId);
              if (notifiedMessagesRef.current.size > 100) notifiedMessagesRef.current.delete(notifiedMessagesRef.current.values().next().value!);
            }
            playIncomingMessageTone();
            setIncomingNotifications((old) => [{ id: messageId || `${conversationId}-${Date.now()}`, conversationId, customerName: event.customer?.name || event.conversation?.customer?.name || "عميل جديد", channel: event.conversation?.channel, preview: messageNotificationPreview(event.message), createdAt: event.message.createdAt || new Date().toISOString() }, ...old].slice(0, 8));
            setShowNotifications(true);
          }
        }
        if (event.message && conversationId === detailLoadingIdRef.current) loadingMessagesRef.current.set(conversationId, mergeMessages(loadingMessagesRef.current.get(conversationId) || [], event.message));
        if (event.message && conversationId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], event.message) } : old);
      });
      connection.on("message:transcribed", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: mergeMessages(old.messages || [], event.message) } : old));
      connection.on("csat:low", (event) => { setCsatAlert(`تقييم منخفض (${event.rating}/5) من ${event.customer?.name || "عميل"}.`); load(profile); });
      connection.on("csat:received", () => load(profile));
      connection.on("csat:delivery-failed", (event) => { setCsatAlert(`تعذر إرسال استبيان الرضا للمحادثة ${event.conversationId}.`); load(profile); });
      connection.on("whisper:new", (note) => setDetail((old: AnyRecord) => old?.id === note.conversationId ? { ...old, whisperNotes: [...(old.whisperNotes || []), note] } : old));
      for (const event of ["conversation:updated", "conversation:queued", "presence:updated", "sla:breached", "team:updated"]) connection.on(event, () => load(profile));
      const requestedConversationId = new URLSearchParams(window.location.search).get("conversation");
      if (requestedConversationId) {
        window.history.replaceState(null, "", window.location.pathname);
        void openConversation({ id: requestedConversationId });
      }
    }).catch(() => { localStorage.removeItem("bondoq_token"); router.replace("/login"); });
    return () => { connection?.disconnect(); };
  }, [router]);

  async function openConversation(item: AnyRecord) {
    if (selected && selected.id !== item.id) socket?.emit("conversation:leave", selected.id);
    const request = ++detailRequest.current;
    if (detailLoadingIdRef.current && detailLoadingIdRef.current !== item.id) loadingMessagesRef.current.delete(detailLoadingIdRef.current);
    detailLoadingIdRef.current = item.id; stickToBottom.current = true; setShowJumpToBottom(false); setSelected(item); setDetail(null); setError(""); socket?.emit("conversation:join", item.id);
    try {
      const conversation = await api(`/api/conversations/${item.id}`);
      if (request === detailRequest.current) {
        const queuedMessages = loadingMessagesRef.current.get(item.id) || [];
        loadingMessagesRef.current.delete(item.id); detailLoadingIdRef.current = "";
        setDetail({ ...conversation, messages: mergeMessages(conversation.messages || [], queuedMessages) });
      }
    } catch (e) { if (request === detailRequest.current) setError(e instanceof Error ? e.message : "تعذر فتح المحادثة"); }
  }
  function closeConversationPreview() {
    ++detailRequest.current;
    if (selected) socket?.emit("conversation:leave", selected.id);
    if (selected) loadingMessagesRef.current.delete(selected.id);
    detailLoadingIdRef.current = "";
    setSelected(null); setDetail(null); setShowJumpToBottom(false);
  }
  async function sendWhisper(e: FormEvent) {
    e.preventDefault(); if (!selected || !whisper.trim()) return;
    try { await api(`/api/conversations/${selected.id}/whisper`, { method: "POST", body: JSON.stringify({ text: whisper }) }); setWhisper(""); setDetail(await api(`/api/conversations/${selected.id}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "تعذر إرسال الهمسة"); }
  }
  async function sendAdminReply(e: FormEvent) {
    e.preventDefault(); if (!selected || !adminReply.trim()) return;
    const conversationId = selected.id;
    const replyText = adminReply.trim();
    const pendingId = `pending-admin-${Date.now()}`;
    const pending = { id: pendingId, conversationId, author: { name: user?.name || "المدير" }, createdAt: new Date().toISOString(), direction: "OUTBOUND", kind: "TEXT", text: replyText, deliveryStatus: "PENDING" };
    setAdminReply(""); setError("");
    setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], pending) } : old);
    try {
      const message = await api(`/api/conversations/${conversationId}/reply`, { method: "POST", body: JSON.stringify({ text: replyText }) });
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages((old.messages || []).filter((item: AnyRecord) => item.id !== pendingId), message) } : old);
      if (message.deliveryStatus === "QUEUED") setSuccessMessage("أُضيف الرد إلى قائمة إرسال WhatsApp في الخلفية.");
      else if (message.deliveryStatus === "FAILED") setError("تعذر إضافة الرد إلى قائمة إرسال WhatsApp.");
      void load();
    } catch (e) {
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => item.id !== pendingId) } : old);
      setAdminReply((value) => value || replyText);
      setError(e instanceof Error ? e.message : "تعذر إرسال الرد المباشر");
    }
  }
  async function reassign(agentId: string) {
    if (!selected) return;
    const conversationId = selected.id;
    const previousAssignment = { assignedAgentId: detail?.assignedAgentId || null, assignedAgent: detail?.assignedAgent || null, branchId: detail?.branchId || null };
    const nextAgent = agents.find((agent) => agent.id === agentId) || null;
    const nextStatus = agentId ? "OPEN" : "QUEUED";
    setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, assignedAgentId: agentId || null, assignedAgent: nextAgent, branchId: nextAgent?.branchId || null, status: nextStatus } : old);
    try {
      const updated = await api(`/api/conversations/${conversationId}/assignment`, { method: "PATCH", body: JSON.stringify({ agentId: agentId || null }) });
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, ...updated, assignedAgent: agentId ? nextAgent : null } : old);
      await load();
    }
    catch (e) { setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, ...previousAssignment } : old); setError(e instanceof Error ? e.message : "تعذر تحويل المحادثة"); }
  }
  async function routeToBranch(branchId: string) {
    if (!selected || !branchId) return;
    const conversationId = selected.id;
    try {
      const updated = await api(`/api/conversations/${conversationId}/assignment`, { method: "PATCH", body: JSON.stringify({ agentId: null, branchId }) });
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, ...updated, assignedAgent: null } : old);
      setSuccessMessage(`أُرسلت المحادثة إلى طابور ${branches.find((branch) => branch.id === branchId)?.name || "الفرع"}.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر توجيه المحادثة إلى الفرع"); }
  }
  async function setAdminConversationStatus(status: "OPEN" | "RESOLVED" | "CLOSED") {
    if (!selected) return;
    const conversationId = selected.id;
    try {
      const result = await api(`/api/conversations/${conversationId}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, status: result.status, closedAt: result.closedAt } : old);
      setError(result.csatDelivery === "failed" ? "أُغلقت المحادثة لكن تعذر إرسال استبيان الرضا." : status === "CLOSED" ? "أُغلقت المحادثة." : "تم حل المحادثة.");
      await load();
    }
    catch (e) { setError(e instanceof Error ? e.message : "تعذر تحديث حالة المحادثة"); }
  }
  async function logout() { try { await api("/api/auth/logout", { method: "POST" }); } catch { /* clear the local session even if the API is unreachable */ } socket?.disconnect(); localStorage.removeItem("bondoq_token"); router.replace("/login"); }

  const visibleConversations = conversations.filter((chat) => `${chat.customer?.name || "عميل"} ${chat.customer?.phone || ""} ${chat.messages?.[0]?.text || ""}`.toLowerCase().includes(search.toLowerCase()));
  const kpis = data?.kpis || {};

  return <main className="min-h-screen bg-[#f7f5f1] pb-10">
    <header className="sticky top-0 z-20 border-b border-stone-200/80 bg-white/95 backdrop-blur"><div className="mx-auto flex h-[74px] max-w-[1500px] items-center justify-between px-4 sm:px-7">
      <div className="flex items-center gap-3"><BrandMark /><div><div className="text-lg font-extrabold text-stone-800">مركز القيادة</div><div className="text-[11px] text-stone-400">المراقبة الحية وإدارة الفريق</div></div></div>
      <div className="hidden items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 sm:flex"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> النظام متصل</div>
        <div className="flex items-center gap-1 sm:gap-2"><button type="button" aria-label="فتح إشعارات الرسائل" onClick={() => setShowNotifications((open) => !open)} className="relative grid h-10 w-10 place-items-center rounded-xl text-stone-500 hover:bg-stone-100"><Bell size={18} />{incomingNotifications.length > 0 ? <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#d32f2f] px-1 text-[9px] font-bold text-white">{incomingNotifications.length}</span> : kpis.slaBreached > 0 && <i className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" />}</button><PushNotificationsButton /><InstallAppButton /><button type="button" aria-label={soundEnabled ? "إيقاف صوت الرسائل" : "تشغيل صوت الرسائل"} title={soundEnabled ? "إيقاف صوت الرسائل الجديدة" : "تشغيل صوت الرسائل الجديدة"} onClick={() => { const next = !soundEnabled; setSoundEnabled(next); setNotificationSoundEnabled(next); }} className={`grid h-10 w-10 place-items-center rounded-xl ${soundEnabled ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100"}`}>{soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><span className="hidden text-sm font-bold text-stone-700 sm:inline">{user?.name || "المدير"}</span><button onClick={() => setShowAccount(true)} title="إعدادات الحساب" className="grid h-10 w-10 place-items-center rounded-xl text-stone-500 hover:bg-amber-50 hover:text-amber-700"><UserRound size={18} /></button><button onClick={logout} title="تسجيل الخروج" className="grid h-10 w-10 place-items-center rounded-xl text-stone-500 hover:bg-red-50 hover:text-red-600"><LogOut size={18} /></button></div>
     </div></header>

     {showNotifications && <><div className="fixed inset-0 z-40 bg-stone-900/20" onClick={() => setShowNotifications(false)} aria-hidden="true" /><aside dir="rtl" role="dialog" aria-label="إشعارات الرسائل الجديدة" className="fixed inset-y-0 right-0 z-50 flex w-[min(380px,100vw)] flex-col border-l border-stone-200 bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-stone-100 px-5 py-4"><div><h2 className="text-sm font-extrabold">رسائل جديدة</h2><p className="mt-1 text-[10px] text-stone-400">تظهر هنا آخر الرسائل الواردة مباشرة</p></div><div className="flex items-center gap-2">{incomingNotifications.length > 0 && <button type="button" onClick={() => setIncomingNotifications([])} className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-stone-500 hover:bg-stone-100">مسح الكل</button>}<button type="button" onClick={() => setShowNotifications(false)} aria-label="إغلاق الإشعارات" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18} /></button></div></div><div className="soft-scroll flex-1 overflow-y-auto p-3">{incomingNotifications.length ? incomingNotifications.map((notification) => <button key={notification.id} type="button" onClick={() => { const item = conversations.find((chat) => chat.id === notification.conversationId) || { id: notification.conversationId, customer: { name: notification.customerName }, channel: notification.channel }; setIncomingNotifications((old) => old.filter((entry) => entry.id !== notification.id)); setShowNotifications(false); void openConversation(item); }} className="mb-2 flex w-full flex-col rounded-xl border border-stone-100 bg-[#fffdf7] p-3 text-right transition hover:border-amber-200 hover:bg-[#fff8e9]"><span className="flex w-full items-center justify-between gap-2"><b className="truncate text-xs text-stone-800">{notification.customerName}</b><span className="shrink-0 text-[9px] text-stone-400">{timeAgo(notification.createdAt)}</span></span><span className="mt-1 text-[9px] font-bold text-emerald-700">{channelLabel[notification.channel] || "قناة جديدة"}</span><span className="mt-1 line-clamp-3 w-full text-xs leading-5 text-stone-600">{notification.preview}</span></button>) : <div className="grid h-full place-items-center px-8 text-center text-xs text-stone-400"><div><Bell size={26} className="mx-auto mb-3 text-stone-300" />لا توجد رسائل جديدة الآن.</div></div>}</div></aside></>}

     <div className="mx-auto max-w-[1500px] px-4 pt-7 sm:px-7">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold text-[#c69125]">حلواني بندق</p><h1 className="mt-1 text-2xl font-extrabold text-stone-800">نظرة عامة <span className="text-stone-400">/ اليوم</span></h1></div><div className="flex flex-wrap gap-2"><button onClick={() => setShowKalemly(true)} className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2.5 text-sm font-bold text-emerald-800 shadow-sm hover:bg-emerald-50"><QrCode size={17} /> إعداد واتساب</button><button onClick={() => setShowMessenger(true)} className="flex items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 py-2.5 text-sm font-bold text-blue-800 shadow-sm hover:bg-blue-50"><MessageCircle size={17} /> إعداد ماسنجر</button><button onClick={() => setShowTelegram(true)} className="flex items-center gap-2 rounded-xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-bold text-sky-800 shadow-sm hover:bg-sky-50"><Send size={17} /> إعداد تليجرام</button>{allowed(user, "canManageCatalog") && <><button onClick={() => setShowProducts(true)} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 shadow-sm hover:border-amber-200"><CakeSlice size={17} className="text-amber-600" /> كتالوج المنتجات</button><button onClick={() => setShowAutoReplies(true)} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 shadow-sm hover:border-amber-200">الردود التلقائية</button><button onClick={() => setShowCannedResponses(true)} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 shadow-sm hover:border-amber-200">الردود الجاهزة</button></>}{allowed(user, "canManageTeam") && <button onClick={() => setShowStaff(true)} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 shadow-sm hover:border-red-200"><Users size={17} className="text-[#d32f2f]" /> إدارة الفريق</button>}</div></div>
      {csatAlert && <div className="mb-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><span>{csatAlert}</span><button onClick={() => setCsatAlert("")}><X size={16} /></button></div>}
      {successMessage && <div role="status" className="mb-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800"><span>{successMessage}</span><button onClick={() => setSuccessMessage("")}><X size={16} /></button></div>}
      {error && <div className="mb-4 flex items-center justify-between rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
       <section className="grid grid-cols-2 gap-3 xl:grid-cols-6 sm:gap-4">
        <Kpi icon={<MessageCircle />} label="محادثات مفتوحة" value={kpis.openChats ?? "—"} foot="تحت متابعة الفريق" tint="red" />
        <Kpi icon={<Clock3 />} label="بانتظار الرد" value={kpis.queue ?? "—"} foot="في طابور الإسناد" tint="gold" />
         <Kpi icon={<ShieldAlert />} label="تجاوزت المهلة" value={kpis.slaBreached ?? "—"} foot="مهلة الرد ٥ دقائق" tint="urgent" alert={kpis.slaBreached > 0} />
        <Kpi icon={<Activity />} label="متوسط الرد الأول" value={formatDuration(kpis.avgResponseSeconds)} foot="متوسط اليوم" tint="green" />
        <Kpi icon={<Check />} label="أُغلقت اليوم" value={kpis.closedToday ?? "—"} foot="محادثة مكتملة" tint="neutral" />
        <Kpi icon={<span>★</span>} label="رضا العملاء" value={kpis.avgCsat ?? "—"} foot={`${kpis.csatCount || 0} تقييم`} tint="gold" />
      </section>

      <section className="mt-6 grid gap-5 xl:grid-cols-[1.13fr_.87fr]">
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-5 py-4"><div><h2 className="font-extrabold text-stone-800">حالة الفريق</h2><p className="text-xs text-stone-400">أداء الموظفين ومحادثاتهم النشطة</p></div><span className="rounded-full bg-[#fff8e1] px-3 py-1 text-xs font-bold text-[#9c7418]">{data?.agents?.filter((a: AnyRecord) => a.presence === "ONLINE").length || 0} متصل الآن</span></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-right text-sm"><thead className="bg-[#fcfbf9] text-[11px] font-bold text-stone-400"><tr><th className="px-5 py-3">الموظف</th><th className="px-3 py-3">الحالة</th><th className="px-3 py-3">محادثات</th><th className="px-3 py-3">SLA متجاوزة</th><th className="px-3 py-3">سرعة الرد</th><th className="px-3 py-3">رضا العملاء</th><th className="px-3 py-3">طلبات مغلقة</th><th className="px-5 py-3">الدوام اليوم</th></tr></thead><tbody className="divide-y divide-stone-100">{(data?.agents || []).map((agent: AnyRecord) => <tr key={agent.id} className="hover:bg-stone-50/60"><td className="px-5 py-3.5"><div className="flex items-center gap-3"><Avatar name={agent.name} /><div><div className="font-bold text-stone-700">{agent.name}</div><div className="text-[10px] text-stone-400">{deptLabel[agent.department] || "فريق بندق"}</div></div></div></td><td className="px-3 py-3"><PresencePill status={agent.presence} /></td><td className="px-3 py-3 font-bold text-stone-700">{agent.activeChats}</td><td className={`px-3 py-3 font-bold ${agent.slaBreachedChats ? "text-red-600" : "text-stone-500"}`}>{agent.slaBreachedChats}</td><td className="px-3 py-3 text-stone-600">{formatDuration(agent.avgResponseSeconds)}</td><td className={`px-3 py-3 font-bold ${agent.avgCsat !== null && agent.avgCsat < 3 ? "text-red-600" : "text-amber-700"}`}>{agent.avgCsat ?? "—"} <span className="text-[10px] font-normal text-stone-400">({agent.csatCount || 0})</span></td><td className="px-3 py-3 text-stone-600">{agent.closedOrders}</td><td className="px-5 py-3 text-stone-600">{formatDuration(agent.sessionMinutes * 60)}</td></tr>)}</tbody></table></div>
        </div>
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4"><div><h2 className="font-extrabold text-stone-800">آخر الأحداث</h2><p className="text-xs text-stone-400">سجل رقابي مباشر</p></div><FileText size={18} className="text-stone-400" /></div>
          <div className="max-h-[350px] divide-y divide-stone-100 overflow-y-auto">{(data?.recentAudit || []).map((log: AnyRecord) => <div key={log.id} className="flex gap-3 px-5 py-3.5"><div className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#fff8e1] text-[#b88718]"><Activity size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-stone-700">{auditText(log.action)}</p><p className="mt-1 text-[11px] text-stone-400">{log.actor?.name || "النظام"} · {timeAgo(log.createdAt)}</p></div></div>)}{!data?.recentAudit?.length && <Empty text="ستظهر هنا حركات الفريق" />}</div>
        </div>
      </section>

      <section className="panel mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-5 py-4"><div><h2 className="font-extrabold text-stone-800">كل المحادثات</h2><p className="text-xs text-stone-400">افتح أي محادثة للمشاهدة أو التدخل</p></div><label className="flex h-10 min-w-48 items-center gap-2 rounded-xl bg-[#f7f5f1] px-3"><Search size={16} className="text-stone-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن عميل..." className="w-full bg-transparent text-xs outline-none" /></label></div>
         <div className="grid divide-y divide-stone-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0 lg:divide-x-reverse">{visibleConversations.slice(0, 12).map((chat) => <button key={chat.id} onClick={() => openConversation(chat)} className="flex min-w-0 items-center gap-3 px-5 py-4 text-right transition hover:bg-[#fffaf3]"><Avatar name={chat.customer?.name || "عميل"} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><b className="truncate text-sm text-stone-700">{chat.customer?.name || "عميل جديد"}</b><ChannelBadge channel={chat.channel} />{chat.isComplaint && <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-600">شكوى</span>}</div><p className="mt-1 truncate text-xs text-stone-400">{chat.messages?.[0]?.text || "مرفق أو رسالة جديدة"}</p></div><div className="flex shrink-0 flex-col items-end gap-1"><span className="text-[10px] text-stone-400">{timeAgo(chat.lastMessageAt)}</span>{chat.slaBreachedAt ? <span className="sla-pulse rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">متأخرة</span> : <span className="text-[10px] text-stone-400">{chat.assignedAgent?.name || "بانتظار إسناد"}</span>}</div></button>)}{!visibleConversations.length && <Empty text="لا توجد محادثات مطابقة" />}</div>
      </section>
    </div>

    {selected && <div className="fixed inset-0 z-40 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={closeConversationPreview}><div className="panel flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
      {detail ? <>
       <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4"><div className="flex items-center gap-3"><Avatar name={detail.customer?.name || "عميل"} /><div><h3 className="font-extrabold">{detail.customer?.name || "عميل جديد"}</h3><p className="text-xs text-stone-400">{channelLabel[detail.channel]} · {detail.assignedAgent?.name || "غير مسندة"}</p></div></div><button onClick={closeConversationPreview} className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={19} /></button></div>
        <div className="flex flex-wrap gap-2 border-b border-stone-100 bg-white px-5 py-2"><button type="button" onClick={() => void setAdminConversationStatus("RESOLVED")} className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[10px] font-bold text-emerald-700"><CheckCircle2 size={14} /> حل المحادثة</button><button type="button" onClick={() => void setAdminConversationStatus(detail.status === "CLOSED" || detail.status === "RESOLVED" ? "OPEN" : "CLOSED")} className="flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-[10px] font-bold text-stone-600">{detail.status === "CLOSED" || detail.status === "RESOLVED" ? <MessageCircle size={14} /> : <Archive size={14} />}{detail.status === "CLOSED" || detail.status === "RESOLVED" ? "إعادة فتح" : "إغلاق"}</button><span className="mr-auto self-center text-[10px] text-stone-400">الحالة: {detail.status}</span></div>
        {detail.serviceTag && <div className="border-b border-amber-100 bg-amber-50/60 px-5 py-2 text-xs font-bold text-amber-900">الخدمة المطلوبة: {detail.serviceTag}</div>}
       <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 bg-[#fffdf7] px-5 py-3"><span className="text-xs font-bold text-stone-600">تحويل / استلام</span>{allowed(user, "canTransferConversations") && <><select value={detail.assignedAgentId || ""} onChange={(e) => reassign(e.target.value)} className="h-9 rounded-lg border border-stone-200 bg-white px-3 text-xs outline-none"><option value="">إبقاء في الطابور</option>{agents.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}{a.branch?.name ? ` · ${a.branch.name}` : ""} · {presenceLabel[a.presence]}</option>)}</select><select value={detail.branchId || ""} onChange={(e) => void routeToBranch(e.target.value)} className="h-9 rounded-lg border border-stone-200 bg-white px-3 text-xs outline-none"><option value="">توجيه إلى طابور فرع</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></>}<span className="mr-auto text-xs text-stone-400">{detail.slaBreachedAt ? "تجاوزت مهلة الرد" : "مراقبة مباشرة"}</span></div>
       <div ref={messageListRef} onScroll={(event) => { const element = event.currentTarget; const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120; stickToBottom.current = atBottom; setShowJumpToBottom(!atBottom); }} className="soft-scroll relative flex-1 space-y-3 overflow-y-auto bg-[#fffdf7] px-5 py-4">{(detail.messages || []).map((message: AnyRecord) => <div key={message.id} className={`flex ${message.direction === "OUTBOUND" ? "justify-start" : "justify-end"}`}><div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-7 ${message.direction === "OUTBOUND" ? "rounded-tr-sm bg-white shadow-sm" : "rounded-tl-sm bg-[#fce8c5]"}`}>{["IMAGE", "AUDIO", "FILE"].includes(message.kind) && (message.mediaAssetId || message.direction === "INBOUND" ? <AdminProtectedMedia conversationId={detail.id} message={message} /> : message.kind === "IMAGE" && message.mediaUrl ? <img src={message.mediaUrl} alt="صورة مرفقة" className="mb-2 max-h-56 rounded-xl object-cover" /> : message.mediaUrl ? <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="mb-2 block text-xs font-bold text-blue-700 underline">فتح المرفق</a> : null)}{message.text || (message.kind === "LOCATION" ? `موقع: ${message.latitude}, ${message.longitude}` : message.kind === "AUDIO" ? "رسالة صوتية" : "مرفق")}{message.transcription && <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 text-xs leading-6 text-stone-600">تفريغ صوتي: {message.transcription}</p>}{message.direction === "OUTBOUND" && <p className="mt-1 text-[10px] text-stone-400">{message.author?.name || "فريق بندق"} · {timeAgo(message.createdAt)}</p>}</div></div>)}<div ref={messageEndRef} />{showJumpToBottom && <button type="button" onClick={() => { stickToBottom.current = true; messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); setShowJumpToBottom(false); }} className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white shadow-lg"><ArrowDown size={13} /> الرسائل الجديدة</button>}</div>
      <div className="space-y-2 border-t border-stone-100 bg-white p-4"><form onSubmit={sendAdminReply} className="flex gap-2"><input value={adminReply} onChange={(e) => setAdminReply(e.target.value)} placeholder="رد مباشر للعميل بصفتك مديرًا..." className="min-w-0 flex-1 rounded-xl border border-stone-200 px-3 text-sm outline-none focus:border-red-200" /><button disabled={!adminReply.trim()} className="grid h-10 w-11 place-items-center rounded-xl bg-[#d32f2f] text-white hover:bg-[#b71c1c] disabled:opacity-40" title="إرسال رد مباشر"><Send size={16} /></button></form><form onSubmit={sendWhisper} className="flex gap-2"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fff5d8] text-[#ae811e]"><Headset size={17} /></div><input value={whisper} onChange={(e) => setWhisper(e.target.value)} placeholder="توجيه سري للموظف... لا يظهر للعميل" className="min-w-0 flex-1 rounded-xl border border-[#efdda9] bg-[#fffaf0] px-3 text-sm outline-none focus:border-[#d6aa43]" /><button className="grid h-10 w-11 place-items-center rounded-xl bg-[#d5a52e] text-white hover:bg-[#be8d18]" title="إرسال همسة"><Send size={16} /></button></form><p className="pr-12 text-[10px] text-stone-400">الرد المباشر يظهر للعميل، والهمسة للموظف فقط.</p></div>
      </> : <div className="grid min-h-72 flex-1 place-items-center text-sm text-stone-400">جارٍ تحميل المحادثة...</div>}
    </div></div>}

        {showStaff && <TeamManagementModal onClose={() => setShowStaff(false)} onDone={() => { void load(); }} />}
       {showProducts && <ProductManagementModal onClose={() => setShowProducts(false)} />}
       {showAutoReplies && <AutoReplyRulesModal onClose={() => setShowAutoReplies(false)} />}
       {showCannedResponses && <CannedResponsesModal onClose={() => setShowCannedResponses(false)} />}
      {showKalemly && <KalemlySettingsModal onClose={() => setShowKalemly(false)} />}
      {showMessenger && <MessengerSettingsModal onClose={() => setShowMessenger(false)} />}
      {showTelegram && <TelegramSettingsModal onClose={() => setShowTelegram(false)} />}
      {showAccount && user && <AccountSettingsModal user={user} onClose={() => setShowAccount(false)} onSaved={setUser} />}
  </main>;
}

function KalemlySettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AnyRecord | null>(null);
  const [authKey, setAuthKey] = useState("");
  const [appKey, setAppKey] = useState("");
  const [qrCodePayload, setQrCodePayload] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("اختبار من نظام خدمة عملاء حلواني بندق");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const webhookUrl = settings?.webhookUrlToken
    ? `${API_URL}/webhooks/kalemlywa?token=${encodeURIComponent(settings.webhookUrlToken)}`
    : `${API_URL}/webhooks/kalemlywa`;

  useEffect(() => {
    api("/api/admin/integrations/kalemlywa").then((result) => {
      setSettings(result);
      setQrCodePayload(result.qrCodePayload || "");
    }).catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحميل إعدادات واتساب"));
  }, []);

  useEffect(() => {
    let current = true;
    if (!qrCodePayload.trim()) { setQrImage(""); return; }
    QRCode.toDataURL(qrCodePayload.trim(), { width: 240, margin: 2, errorCorrectionLevel: "M" })
      .then((image) => { if (current) setQrImage(image); })
      .catch(() => { if (current) { setQrImage(""); setNotice("حمولة QR طويلة أو غير صالحة؛ ألصق النص أو الرابط الذي يعرضه KalemlyWA للجهاز."); } });
    return () => { current = false; };
  }, [qrCodePayload]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const result = await api("/api/admin/integrations/kalemlywa", { method: "PUT", body: JSON.stringify({ authKey: authKey.trim(), appKey: appKey.trim(), qrCodePayload }) });
      setSettings(result); setQrCodePayload(result.qrCodePayload || ""); setAuthKey(""); setAppKey(""); setNotice("حُفظ مفتاحا KalemlyWA مشفّرين.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الإعدادات"); }
    finally { setSaving(false); }
  }

  async function testConnection(event: FormEvent) {
    event.preventDefault(); setTesting(true); setNotice("");
    try {
      await api("/api/admin/integrations/kalemlywa/test", { method: "POST", body: JSON.stringify({ phone, message }) });
      setNotice("أُرسلت رسالة الاختبار بنجاح عبر قائمة الإرسال.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "فشل إرسال رسالة الاختبار"); }
    finally { setTesting(false); }
  }

  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookCopied(true);
      setNotice("تم نسخ رابط Webhook.");
    } catch {
      setWebhookCopied(false);
      setNotice("تعذر النسخ تلقائيًا؛ حدد الرابط وانسخه يدويًا.");
    }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/50 p-3 backdrop-blur-sm" onClick={onClose}>
    <section className="panel max-h-[94vh] w-full max-w-3xl overflow-y-auto p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
      <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-xs font-bold text-emerald-700">WhatsApp Business · KalemlyWA</p><h2 className="mt-1 text-xl font-extrabold">إعداد اتصال واتساب</h2><p className="mt-1 text-xs leading-5 text-stone-500">أدخل مفتاح الحساب ومفتاح التطبيق كلًّا في خانته؛ يُخزّنان مشفّرين. حمولة QR اختيارية.</p></div><button onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={19} /></button></div>
      <div className="grid gap-5 md:grid-cols-[1fr_.9fr]">
        <div className="space-y-4">
          <form onSubmit={save} className="space-y-3 rounded-2xl bg-[#faf9f7] p-4">
            <label className="block text-xs font-bold text-stone-600">عنوان الإرسال<input readOnly value={settings?.endpoint || "جارٍ التحميل..."} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-stone-100 px-3 text-[11px] font-normal text-stone-500" dir="ltr" /></label>
            <label className="block text-xs font-bold text-stone-600">authkey · مفتاح الحساب{settings?.authKeyConfigured && <span className="mr-2 text-[10px] text-emerald-700">محفوظ</span>}<input type="password" value={authKey} onChange={(event) => setAuthKey(event.target.value)} placeholder={settings?.authKeyConfigured ? "اتركه فارغًا للإبقاء على المفتاح الحالي" : "ألصق authkey من دليل KalemlyWA"} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs font-normal outline-none focus:border-emerald-300" dir="ltr" autoComplete="new-password" /></label>
            <label className="block text-xs font-bold text-stone-600">appkey · مفتاح التطبيق{settings?.appKeyConfigured && <span className="mr-2 text-[10px] text-emerald-700">محفوظ</span>}<input type="password" value={appKey} onChange={(event) => setAppKey(event.target.value)} placeholder={settings?.appKeyConfigured ? "اتركه فارغًا للإبقاء على المفتاح الحالي" : "ألصق appkey لتطبيق Crm"} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs font-normal outline-none focus:border-emerald-300" dir="ltr" autoComplete="new-password" /></label>
            <label className="block text-xs font-bold text-stone-600">QR pairing payload<input value={qrCodePayload} onChange={(event) => setQrCodePayload(event.target.value)} placeholder="ألصق نص أو رابط QR من لوحة KalemlyWA" className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs font-normal outline-none focus:border-emerald-300" dir="ltr" /></label>
            <button disabled={saving || !settings} className="h-10 w-full rounded-xl bg-emerald-700 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50">{saving ? "جارٍ الحفظ..." : "حفظ الإعدادات"}</button>
          </form>
          <div className="rounded-2xl border border-stone-200 bg-white p-4"><h3 className="text-xs font-extrabold">Webhook الوارد</h3><p className="mt-1 text-[10px] leading-5 text-stone-500">انسخ الرابط كاملًا إلى إعدادات Webhook في KalemlyWA. يتضمن الرابط رمز تحقق؛ لا تحذف الجزء الذي يبدأ بـ <span dir="ltr">?token=</span> ولا تشاركه علنًا. لا تحتاج إلى إعداد ترويسة مصادقة لدى المزود.</p><div className="mt-2 flex flex-col gap-2 sm:flex-row"><div dir="ltr" className="min-w-0 flex-1 select-all break-all rounded-lg bg-stone-50 px-3 py-2 font-mono text-xs leading-5 text-stone-700">{webhookUrl}</div><button type="button" onClick={copyWebhookUrl} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white hover:bg-emerald-800" aria-label="نسخ رابط Webhook">{webhookCopied ? <Check size={14} /> : <Copy size={14} />}{webhookCopied ? "تم النسخ" : "نسخ الرابط"}</button></div><p className={`mt-2 text-[10px] font-bold ${settings?.webhookAuthConfigured ? "text-emerald-700" : "text-amber-700"}`}>{settings?.webhookAuthConfigured ? "رمز التحقق جاهز ومضمّن في الرابط" : "يلزم حفظ appkey أو سر Webhook لتفعيل استقبال الرسائل"}</p><p className="mt-2 text-[10px] leading-5 text-amber-800">إذا استمر رد 401 بعد تحديث الرابط في Kalemly، أرسل محاولة جديدة وسنراجعها. لا تغيّر مفتاح تطبيق website.</p></div>
        </div>
        <div className="space-y-4">
          <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-stone-300 bg-white p-4 text-center">{qrImage ? <div><img src={qrImage} alt="رمز ربط واتساب" className="mx-auto h-52 w-52"/><p className="mt-2 text-[10px] text-stone-500">افتح WhatsApp المرتبط وامسح الرمز لتوصيل الجهاز.</p></div> : <div className="max-w-xs text-xs leading-6 text-stone-400"><QrCode size={28} className="mx-auto mb-2"/>لا توجد حمولة QR محفوظة. أدخل النص الذي يوفّره KalemlyWA يدويًا. لم يتم افتراض endpoint غير موثق لجلب الرمز.</div>}</div>
          <form onSubmit={testConnection} className="space-y-3 rounded-2xl bg-emerald-50/70 p-4"><h3 className="text-xs font-extrabold text-emerald-900">اختبار إرسال مباشر</h3><label className="block text-[10px] font-bold text-stone-600">رقم الهاتف<input required value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="رقم دولي مع رمز الدولة، مثل +968 9123 4567" className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs font-normal outline-none" dir="ltr" /></label><label className="block text-[10px] font-bold text-stone-600">نص الاختبار<textarea required value={message} onChange={(event) => setMessage(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-normal outline-none" /></label><button disabled={testing || !settings?.authKeyConfigured || !settings?.appKeyConfigured} className="h-10 w-full rounded-xl bg-emerald-700 text-xs font-bold text-white disabled:opacity-50">{testing ? "جارٍ الإرسال..." : "إرسال رسالة اختبار"}</button></form>
        </div>
      </div>
      {notice && <p className={`mt-4 rounded-xl px-3 py-2 text-xs ${notice.includes("تعذر") || notice.includes("فشل") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{notice}</p>}
    </section>
  </div>;
}

function Kpi({ icon, label, value, foot, tint, alert }: AnyRecord) {
  const shades: Record<string, string> = { red: "bg-red-50 text-[#d32f2f]", gold: "bg-amber-50 text-[#ba8817]", urgent: "bg-red-50 text-red-600", green: "bg-emerald-50 text-emerald-700", neutral: "bg-stone-100 text-stone-600" };
  return <div className={`panel p-4 ${alert ? "border-red-200" : ""}`}><div className="flex items-center justify-between"><span className="text-xs font-bold text-stone-500">{label}</span><span className={`grid h-9 w-9 place-items-center rounded-xl ${shades[tint]} ${alert ? "sla-pulse" : ""}`}>{icon}</span></div><div className={`mt-3 text-3xl font-extrabold ${alert && value > 0 ? "text-red-600" : "text-stone-800"}`}>{value}</div><div className="mt-1 text-[10px] text-stone-400">{foot}</div></div>;
}
function BrandMark() { return <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#d32f2f] text-xl font-black text-[#ffc107] shadow-md shadow-red-200">ب</div>; }
function Avatar({ name, src }: { name: string; src?: string }) { return <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffe4c8] to-[#ffefbf] text-sm font-extrabold text-[#97512e]">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.trim()?.[0] || "ع"}</div>; }
function PresencePill({ status }: { status: string }) { const color: Record<string, string> = { ONLINE: "bg-emerald-50 text-emerald-700", BUSY: "bg-orange-50 text-orange-700", BREAK: "bg-amber-50 text-amber-700", OFFLINE: "bg-stone-100 text-stone-500" }; return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${color[status] || color.OFFLINE}`}>{presenceLabel[status] || status}</span>; }
function ChannelBadge({ channel }: { channel: string }) { const style: Record<string, string> = { WHATSAPP: "bg-emerald-50 text-emerald-700", MESSENGER: "bg-blue-50 text-blue-700", TELEGRAM: "bg-sky-50 text-sky-700" }; return <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-bold ${style[channel] || "bg-stone-100 text-stone-600"}`}>{channelLabel[channel] || channel}</span>; }
function Empty({ text }: { text: string }) { return <p className="px-5 py-10 text-center text-sm text-stone-400">{text}</p>; }
function formatDuration(seconds?: number | null) { if (seconds == null) return "—"; if (seconds < 60) return `${seconds}ث`; return `${Math.floor(seconds / 60)}د ${seconds % 60}ث`; }
function timeAgo(value?: string) { if (!value) return "الآن"; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? "الآن" : minutes < 60 ? `منذ ${minutes} د` : `منذ ${Math.floor(minutes / 60)} س`; }
function auditText(action: string) { const map: Record<string, string> = { MESSAGE_SENT: "تم إرسال رد للعميل", MESSAGE_QUEUED: "أُضيف رد WhatsApp لقائمة الإرسال", WHISPER_SENT: "تم إرسال توجيه سري", CONVERSATION_REASSIGNED: "تم تحويل محادثة", CONVERSATION_HANDOFF: "حوّل موظف محادثة لزميل", CONVERSATION_CLOSED: "تم إغلاق محادثة", SLA_BREACHED: "تجاوزت محادثة مهلة الرد", CONVERSATION_OPENED: "تم فتح محادثة للمراجعة", AGENT_CREATED: "تمت إضافة موظف", PRESENCE_CHANGED: "تم تحديث حالة موظف", CSAT_RECEIVED: "تم استلام تقييم خدمة", PRODUCT_SENT: "تم إرسال منتج للعميل" }; return map[action] || action.replaceAll("_", " "); }

function AdminProtectedMedia({ conversationId, message }: { conversationId: string; message: AnyRecord }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let current = true;
    fetch(`${API_URL}/api/conversations/${conversationId}/messages/${message.id}/media`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((response) => response.ok ? response.blob() : Promise.reject())
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (current) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl); }).catch(() => {});
    return () => { current = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [conversationId, message.id]);
  if (!url) return <span className="mb-2 block text-[10px] text-stone-400">جارٍ تحميل المرفق...</span>;
  if (message.kind === "IMAGE") return <img src={url} alt="صورة مرفقة" className="mb-2 max-h-56 rounded-xl object-cover" />;
  if (message.kind === "AUDIO") return <audio controls src={url} className="mb-2 max-w-full" />;
  return <a href={url} download className="mb-2 block text-xs font-bold text-blue-700 underline">تنزيل المرفق</a>;
}

function StaffManagementModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "", department: "CAKES" });
  const [staff, setStaff] = useState<AnyRecord[]>([]);
  const [usernameEdits, setUsernameEdits] = useState<Record<string, string>>({});
  const [resetId, setResetId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api("/api/admin/agents").then(setStaff).catch((e) => setError(e.message)); }, []);
  async function create(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError("");
    try { const created = await api("/api/admin/agents", { method: "POST", body: JSON.stringify({ ...form, username: form.username || undefined }) }); setStaff((old) => [...old, { ...created, isActive: true, presence: "OFFLINE" }]); setForm({ name: "", email: "", username: "", password: "", department: "CAKES" }); onDone(); }
    catch (err) { setError(err instanceof Error ? err.message : "تعذر إضافة الموظف"); }
    finally { setSaving(false); }
  }
  async function toggle(agent: AnyRecord) {
    try { const updated = await api(`/api/admin/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !agent.isActive }) }); setStaff((old) => old.map((item) => item.id === agent.id ? { ...item, ...updated } : item)); onDone(); }
    catch (err) { setError(err instanceof Error ? err.message : "تعذر تحديث حساب الموظف"); }
  }
  async function saveUsername(agent: AnyRecord) {
    const username = (usernameEdits[agent.id] ?? agent.username).trim();
    if (username.length < 3) return setError("اسم المستخدم يجب ألا يقل عن 3 أحرف");
    try {
      const updated = await api(`/api/admin/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ username }) });
      setStaff((old) => old.map((item) => item.id === agent.id ? { ...item, ...updated } : item));
      setUsernameEdits((old) => ({ ...old, [agent.id]: updated.username })); setError("تم تحديث اسم المستخدم.");
    } catch (err) { setError(err instanceof Error ? err.message : "تعذر تحديث اسم المستخدم"); }
  }
  async function resetPassword(agentId: string) {
    if (newPassword.length < 10) return setError("كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف");
    try { await api(`/api/admin/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ password: newPassword }) }); setResetId(""); setNewPassword(""); setError("تم تحديث كلمة المرور."); }
    catch (err) { setError(err instanceof Error ? err.message : "تعذر تغيير كلمة المرور"); }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-4" onClick={onClose}><div className="panel max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
    <div className="mb-5 flex items-center justify-between"><div><h3 className="text-lg font-extrabold">إدارة الفريق</h3><p className="text-xs text-stone-400">إضافة الحسابات وتحديث صلاحية الوصول</p></div><button onClick={onClose} className="rounded-lg p-2 text-stone-400 hover:bg-stone-100"><X size={18} /></button></div>
    <div className="grid gap-5 md:grid-cols-[.8fr_1.2fr]">
      <form onSubmit={create} className="space-y-3 rounded-2xl bg-[#faf9f7] p-4"><h4 className="mb-2 text-sm font-extrabold">موظف جديد</h4><input required placeholder="الاسم الكامل" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs outline-none focus:border-red-300" /><input required type="email" placeholder="البريد الإلكتروني" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs outline-none focus:border-red-300" /><input minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" placeholder="اسم المستخدم (اختياري)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs outline-none focus:border-red-300" dir="ltr" /><input required minLength={10} type="password" placeholder="كلمة المرور (10 أحرف فأكثر)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs outline-none focus:border-red-300" /><select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-xs outline-none"><option value="CAKES">مبيعات التورتات</option><option value="DELIVERY">طلبات التوصيل</option><option value="CUSTOMER_CARE">خدمة العملاء والشكاوى</option><option value="QUALITY">قسم الجودة</option></select><button disabled={saving} className="h-10 w-full rounded-xl bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-60">{saving ? "جارٍ الحفظ..." : "إنشاء الحساب"}</button></form>
      <div><h4 className="mb-2 text-sm font-extrabold">حسابات الفريق <span className="text-xs font-medium text-stone-400">({staff.length})</span></h4><div className="max-h-[360px] space-y-2 overflow-y-auto">{staff.map((agent) => <div key={agent.id} className="rounded-xl border border-stone-100 p-3"><div className="flex items-center gap-2"><Avatar name={agent.name} /><div className="min-w-0 flex-1"><b className="block truncate text-xs">{agent.name}</b><span className="text-[10px] text-stone-400">{deptLabel[agent.department] || agent.email}</span></div><button onClick={() => toggle(agent)} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-bold ${agent.isActive ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{agent.isActive ? "إيقاف" : "تفعيل"}</button><button onClick={() => { setResetId(resetId === agent.id ? "" : agent.id); setError(""); }} className="rounded-lg bg-stone-100 px-2.5 py-1.5 text-[10px] font-bold text-stone-600">كلمة المرور</button></div><div className="mt-2 flex gap-2"><input value={usernameEdits[agent.id] ?? agent.username} onChange={(event) => setUsernameEdits((old) => ({ ...old, [agent.id]: event.target.value }))} className="h-9 min-w-0 flex-1 rounded-lg border border-stone-200 px-2 text-xs outline-none" aria-label={`اسم المستخدم ${agent.name}`} dir="ltr" /><button onClick={() => saveUsername(agent)} className="rounded-lg bg-amber-50 px-3 text-[10px] font-bold text-amber-800">حفظ الاسم</button></div>{resetId === agent.id && <div className="mt-2 flex gap-2"><input type="password" minLength={10} placeholder="كلمة مرور جديدة" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-stone-200 px-2 text-xs outline-none" /><button onClick={() => resetPassword(agent.id)} className="rounded-lg bg-[#d32f2f] px-3 text-[10px] font-bold text-white">حفظ</button></div>}</div>)}{!staff.length && <p className="rounded-xl bg-stone-50 p-5 text-center text-xs text-stone-400">لا يوجد موظفون بعد.</p>}</div></div>
    </div>{error && <p className={`mt-4 rounded-lg px-3 py-2 text-xs ${error.includes("تم تحديث") ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{error}</p>}
  </div></div>;
}

function ProductManagementModal({ onClose }: { onClose: () => void }) {
  const [products, setProducts] = useState<AnyRecord[]>([]);
  const [form, setForm] = useState({ name: "", category: "CAKES", price: "", imageUrl: "", imageAssetId: "", description: "" });
  const [editingId, setEditingId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api("/api/admin/products").then(setProducts).catch((e) => setError(e.message)); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const body = { ...form, price: Number(form.price), imageUrl: form.imageAssetId ? null : form.imageUrl || null, imageAssetId: form.imageAssetId || null, description: form.description || null };
      const product = editingId
        ? await api(`/api/admin/products/${editingId}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/api/admin/products", { method: "POST", body: JSON.stringify(body) });
      setProducts((old) => editingId ? old.map((item) => item.id === editingId ? product : item) : [...old, product]);
      setEditingId(""); setForm({ name: "", category: "CAKES", price: "", imageUrl: "", imageAssetId: "", description: "" });
    }
    catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ المنتج"); }
    finally { setSaving(false); }
  }
  function edit(product: AnyRecord) {
    setEditingId(product.id);
    setForm({ name: product.name, category: product.category, price: String(product.price), imageUrl: product.imageUrl || "", imageAssetId: product.imageAssetId || "", description: product.description || "" });
    setError("");
  }
  async function uploadProductImage(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") { setError("اختر صورة JPG أو PNG أو WebP."); return; }
    if (file.size > 12 * 1024 * 1024) { setError("حجم الصورة الأقصى 12 ميجابايت."); return; }
    setSaving(true); setError("");
    try {
      const response = await fetch(`${API_URL}/api/media`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const asset = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(asset.error || `تعذر رفع الصورة (${response.status})`);
      setForm((old) => ({ ...old, imageAssetId: asset.id, imageUrl: asset.url }));
      setError("تم تحميل الصورة. احفظ المنتج لتثبيتها في الكتالوج.");
    } catch (error) { setError(error instanceof Error ? error.message : "تعذر رفع صورة المنتج"); }
    finally { setSaving(false); }
  }
  async function toggle(product: AnyRecord) {
    try { const updated = await api(`/api/admin/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ isAvailable: !product.isAvailable }) }); setProducts((old) => old.map((item) => item.id === product.id ? updated : item)); }
    catch (e) { setError(e instanceof Error ? e.message : "تعذر تحديث المنتج"); }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-4" onClick={onClose}>
    <div className="panel max-h-[92vh] w-full max-w-4xl overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
      <div className="mb-5 flex items-center justify-between"><div><h3 className="text-lg font-extrabold">كتالوج حلواني بندق</h3><p className="text-xs text-stone-400">إدارة الأسعار والصور وحالة التوفر</p></div><button onClick={onClose} className="rounded-lg p-2 text-stone-400"><X size={18} /></button></div>
       <div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
        <form onSubmit={save} className="space-y-3 rounded-2xl bg-[#faf9f7] p-4">
          <h4 className="text-sm font-extrabold">{editingId ? "تعديل المنتج" : "إضافة منتج"}</h4>
          <input required minLength={2} placeholder="اسم المنتج" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs" />
           <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs"><option value="EASTERN">حلويات شرقية</option><option value="WESTERN">حلويات غربية</option><option value="CAKES">تورتات</option><option value="BAKERY">مخبوزات</option><option value="KAHK">كحك وبسكويت</option><option value="CHOCOLATE">شوكولاتة</option><option value="MOULID">حلاوة المولد</option><option value="OCCASIONS">مناسبات</option><option value="MIX_BONDOQ">ميكس بندق</option></select>
          <input required type="number" min="0" step="0.01" placeholder="السعر بالجنيه" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs" />
          <label className="block text-xs font-bold text-stone-600">تحميل صورة من جهازك<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { void uploadProductImage(event.target.files?.[0]); event.target.value = ""; }} className="mt-1 block w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-normal" /></label>
          <input type="url" placeholder="أو رابط صورة HTTPS" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value, imageAssetId: "" })} className="h-10 w-full rounded-xl border border-stone-200 px-3 text-xs" />
          <textarea placeholder="وصف مختصر" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full rounded-xl border border-stone-200 px-3 py-2 text-xs" />
          <button disabled={saving} className="h-10 w-full rounded-xl bg-[#d32f2f] text-xs font-bold text-white">{saving ? "جارٍ الحفظ..." : editingId ? "حفظ التعديلات" : "حفظ المنتج"}</button>
          {editingId && <button type="button" onClick={() => { setEditingId(""); setForm({ name: "", category: "CAKES", price: "", imageUrl: "", imageAssetId: "", description: "" }); }} className="h-9 w-full rounded-xl bg-stone-100 text-xs font-bold text-stone-600">إلغاء التعديل</button>}
        </form>
       <div className="space-y-2"><h4 className="mb-2 text-sm font-extrabold">المنتجات ({products.length})</h4><div className="max-h-[480px] space-y-2 overflow-y-auto">{products.map((product) => <div key={product.id} className="flex items-center gap-2 rounded-xl border border-stone-100 p-3 sm:gap-3"><div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-amber-50">{product.imageUrl ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" /> : <CakeSlice size={18} className="text-amber-700" />}</div><div className="min-w-0 flex-1"><b className="block truncate text-xs">{product.name}</b><span className="text-[10px] text-stone-400">{categoryLabel[product.category] || product.category} · {Number(product.price).toFixed(2)} ج.م</span></div><button onClick={() => edit(product)} className="rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] font-bold text-amber-800">تعديل</button><button onClick={() => toggle(product)} className={`rounded-lg px-2 py-1.5 text-[10px] font-bold ${product.isAvailable ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"}`}>{product.isAvailable ? "متوفر" : "غير متوفر"}</button></div>)}</div></div>
      </div>
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </div>
  </div>;
}

function AutoReplyRulesModal({ onClose }: { onClose: () => void }) {
  const [rules, setRules] = useState<AnyRecord[]>([]);
  const [welcomeText, setWelcomeText] = useState("");
  const [welcomeActive, setWelcomeActive] = useState(true);
  const [form, setForm] = useState({ name: "", keywords: "", responseText: "", routingDepartment: "", priority: "0" });
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const welcome = rules.find((rule) => rule.isWelcome);

  useEffect(() => {
    api("/api/admin/auto-replies").then((items) => {
      setRules(items);
      const greeting = items.find((rule: AnyRecord) => rule.isWelcome);
      setWelcomeText(greeting?.responseText || "أهلًا بك في حلواني بندق.");
      setWelcomeActive(greeting?.isActive ?? true);
    }).catch((error) => setNotice(error.message));
  }, []);

  async function saveWelcome() {
    setSaving(true); setNotice("");
    try {
      const body = { name: "رسالة الترحيب", keywords: [], responseText: welcomeText.trim(), routingDepartment: null, isActive: welcomeActive, isWelcome: true, priority: 100 };
      const saved = welcome
        ? await api(`/api/admin/auto-replies/${welcome.id}`, { method: "PATCH", body: JSON.stringify({ responseText: body.responseText, isActive: body.isActive }) })
        : await api("/api/admin/auto-replies", { method: "POST", body: JSON.stringify(body) });
      setRules((old) => welcome ? old.map((rule) => rule.id === saved.id ? saved : rule) : [saved, ...old]);
      setNotice("تم حفظ رسالة الترحيب.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ رسالة الترحيب"); }
    finally { setSaving(false); }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    const body = { name: form.name.trim(), keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean), responseText: form.responseText.trim(), routingDepartment: form.routingDepartment || null, priority: Number(form.priority), isActive: true };
    try {
      const saved = editingId
        ? await api(`/api/admin/auto-replies/${editingId}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/api/admin/auto-replies", { method: "POST", body: JSON.stringify(body) });
      setRules((old) => editingId ? old.map((rule) => rule.id === editingId ? saved : rule) : [...old, saved]);
      setEditingId(""); setForm({ name: "", keywords: "", responseText: "", routingDepartment: "", priority: "0" }); setNotice("تم حفظ قاعدة الرد التلقائي.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ القاعدة"); }
    finally { setSaving(false); }
  }

  async function toggleRule(rule: AnyRecord) {
    try {
      const saved = await api(`/api/admin/auto-replies/${rule.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !rule.isActive }) });
      setRules((old) => old.map((item) => item.id === rule.id ? saved : item));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث القاعدة"); }
  }

  async function deleteRule(rule: AnyRecord) {
    try { await api(`/api/admin/auto-replies/${rule.id}`, { method: "DELETE" }); setRules((old) => old.filter((item) => item.id !== rule.id)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف القاعدة"); }
  }

  function editRule(rule: AnyRecord) {
    setEditingId(rule.id);
    setForm({ name: rule.name, keywords: (rule.keywords || []).join(", "), responseText: rule.responseText, routingDepartment: rule.routingDepartment || "", priority: String(rule.priority || 0) });
    setNotice("");
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/45 p-3" onClick={onClose}><section className="panel max-h-[94vh] w-full max-w-4xl overflow-y-auto p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
    <div className="mb-5 flex items-center justify-between"><div><h2 className="text-lg font-extrabold">الردود التلقائية وقواعد التوجيه</h2><p className="text-xs text-stone-400">تُرسل القاعدة عند مطابقة إحدى الكلمات في رسالة العميل.</p></div><button onClick={onClose} className="rounded-lg p-2 text-stone-400"><X size={18} /></button></div>
    <div className="mb-5 grid gap-3 rounded-2xl border border-amber-100 bg-amber-50/60 p-4 sm:grid-cols-[1fr_auto]"><label className="block text-xs font-bold text-amber-950">رسالة الترحيب وقائمة الاختيار<textarea value={welcomeText} onChange={(event) => setWelcomeText(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-xs font-normal outline-none" /></label><div className="flex items-end gap-2"><label className="flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-[10px] font-bold"><input type="checkbox" checked={welcomeActive} onChange={(event) => setWelcomeActive(event.target.checked)} /> مفعّلة</label><button type="button" onClick={() => void saveWelcome()} disabled={saving} className="h-10 rounded-lg bg-amber-700 px-4 text-xs font-bold text-white disabled:opacity-50">حفظ الترحيب</button></div><p className="text-[10px] leading-5 text-amber-900 sm:col-span-2">النظام يضيف خيارات الخدمة (الدليفري، التورتات، المنيو، الشكاوى) بعد هذا النص.</p></div>
    <div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]">
      <form onSubmit={saveRule} className="space-y-3 rounded-2xl bg-stone-50 p-4"><h3 className="text-sm font-extrabold">{editingId ? "تعديل القاعدة" : "قاعدة جديدة"}</h3><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="اسم القاعدة" className="h-10 w-full rounded-lg border border-stone-200 px-3 text-xs" /><input required value={form.keywords} onChange={(event) => setForm({ ...form, keywords: event.target.value })} placeholder="كلمات مفتاحية مفصولة بفاصلة" className="h-10 w-full rounded-lg border border-stone-200 px-3 text-xs" /><textarea required value={form.responseText} onChange={(event) => setForm({ ...form, responseText: event.target.value })} placeholder="الرد الذي سيرسله النظام" rows={4} className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs" /><select value={form.routingDepartment} onChange={(event) => setForm({ ...form, routingDepartment: event.target.value })} className="h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-xs"><option value="">من دون تحويل تلقائي</option><option value="DELIVERY">طلبات التوصيل</option><option value="CAKES">مبيعات التورتات</option><option value="CUSTOMER_CARE">خدمة العملاء</option><option value="QUALITY">الجودة والشكاوى</option></select><label className="block text-[10px] font-bold text-stone-500">الأولوية<input type="number" min="0" max="100" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal" /></label><button disabled={saving} className="h-10 w-full rounded-lg bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ..." : editingId ? "حفظ التعديل" : "إضافة القاعدة"}</button>{editingId && <button type="button" onClick={() => { setEditingId(""); setForm({ name: "", keywords: "", responseText: "", routingDepartment: "", priority: "0" }); }} className="h-9 w-full rounded-lg bg-white text-xs font-bold text-stone-500">إلغاء التعديل</button>}</form>
      <div className="space-y-2"><h3 className="text-sm font-extrabold">القواعد ({rules.filter((rule) => !rule.isWelcome).length})</h3><div className="max-h-[530px] space-y-2 overflow-y-auto">{rules.filter((rule) => !rule.isWelcome).map((rule) => <article key={rule.id} className="rounded-xl border border-stone-100 p-3"><div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate text-xs">{rule.name}</b><button type="button" onClick={() => editRule(rule)} className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] font-bold text-amber-800">تعديل</button><button type="button" onClick={() => void toggleRule(rule)} className="rounded-lg bg-stone-100 px-2.5 py-1.5 text-[10px] font-bold text-stone-600">{rule.isActive ? "إيقاف" : "تفعيل"}</button><button type="button" onClick={() => void deleteRule(rule)} className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[10px] font-bold text-red-600">حذف</button></div><p className="mt-1 text-[10px] text-stone-400">عند ورود: {(rule.keywords || []).join("، ") || "—"} · {rule.routingDepartment || "دون تحويل"} · {rule.isActive ? "مفعّلة" : "متوقفة"}</p><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-stone-700">{rule.responseText}</p></article>)}{!rules.some((rule) => !rule.isWelcome) && <p className="rounded-xl bg-stone-50 p-6 text-center text-xs text-stone-400">لا توجد قواعد إضافية بعد.</p>}</div></div>
    </div>{notice && <p role="status" className="mt-4 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700">{notice}</p>}
  </section></div>;
}

function CannedResponsesModal({ onClose }: { onClose: () => void }) {
  const [responses, setResponses] = useState<AnyRecord[]>([]);
  const [form, setForm] = useState({ shortcut: "/", title: "", content: "" });
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api("/api/admin/canned-responses").then(setResponses).catch((error) => setNotice(error.message)); }, []);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const saved = editingId
        ? await api(`/api/admin/canned-responses/${editingId}`, { method: "PATCH", body: JSON.stringify(form) })
        : await api("/api/admin/canned-responses", { method: "POST", body: JSON.stringify(form) });
      setResponses((old) => editingId ? old.map((item) => item.id === editingId ? saved : item) : [...old, saved]);
      setEditingId(""); setForm({ shortcut: "/", title: "", content: "" }); setNotice("تم حفظ الرد الجاهز.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الرد"); }
    finally { setSaving(false); }
  }
  async function toggle(item: AnyRecord) {
    try { const saved = await api(`/api/admin/canned-responses/${item.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !item.isActive }) }); setResponses((old) => old.map((entry) => entry.id === item.id ? saved : entry)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الرد"); }
  }
  async function remove(item: AnyRecord) {
    try { await api(`/api/admin/canned-responses/${item.id}`, { method: "DELETE" }); setResponses((old) => old.filter((entry) => entry.id !== item.id)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف الرد"); }
  }
  function edit(item: AnyRecord) { setEditingId(item.id); setForm({ shortcut: item.shortcut, title: item.title, content: item.content }); setNotice(""); }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/45 p-3" onClick={onClose}><section className="panel max-h-[92vh] w-full max-w-4xl overflow-y-auto p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
    <div className="mb-5 flex items-center justify-between"><div><h2 className="text-lg font-extrabold">إدارة الردود الجاهزة</h2><p className="text-xs text-stone-400">يستخدم الموظفون الاختصار الذي يبدأ بـ / للعثور على الرد.</p></div><button onClick={onClose} className="rounded-lg p-2 text-stone-400"><X size={18} /></button></div>
    <div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><form onSubmit={save} className="space-y-3 rounded-2xl bg-stone-50 p-4"><h3 className="text-sm font-extrabold">{editingId ? "تعديل الرد" : "رد جاهز جديد"}</h3><input required value={form.shortcut} onChange={(event) => setForm({ ...form, shortcut: event.target.value })} dir="ltr" placeholder="/اختصار" className="h-10 w-full rounded-lg border border-stone-200 px-3 text-xs" /><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="عنوان الرد" className="h-10 w-full rounded-lg border border-stone-200 px-3 text-xs" /><textarea required rows={6} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="نص الرد" className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs leading-6" /><button disabled={saving} className="h-10 w-full rounded-lg bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ..." : editingId ? "حفظ التعديل" : "إضافة الرد"}</button>{editingId && <button type="button" onClick={() => { setEditingId(""); setForm({ shortcut: "/", title: "", content: "" }); }} className="h-9 w-full rounded-lg bg-white text-xs font-bold text-stone-500">إلغاء التعديل</button>}</form>
      <div className="space-y-2"><h3 className="text-sm font-extrabold">الردود ({responses.length})</h3><div className="max-h-[560px] space-y-2 overflow-y-auto">{responses.map((item) => <article key={item.id} className="rounded-xl border border-stone-100 p-3"><div className="flex flex-wrap items-center gap-2"><b dir="ltr" className="rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-800">{item.shortcut}</b><b className="min-w-0 flex-1 text-xs">{item.title}</b><button type="button" onClick={() => edit(item)} className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] font-bold text-amber-800">تعديل</button><button type="button" onClick={() => void toggle(item)} className="rounded-lg bg-stone-100 px-2.5 py-1.5 text-[10px] font-bold text-stone-600">{item.isActive ? "إيقاف" : "تفعيل"}</button><button type="button" onClick={() => void remove(item)} className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[10px] font-bold text-red-600">حذف</button></div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-stone-600">{item.content}</p></article>)}</div></div>
    </div>{notice && <p role="status" className="mt-4 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700">{notice}</p>}
  </section></div>;
}
