"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Archive, ArrowDown, ArrowLeft, CakeSlice, Check, CheckCircle2, Clock3, ImagePlus, MapPin, MessageCircle, MoreHorizontal, Paperclip, Phone, Printer, Search, Send, UserRound, Users } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";
import { cairoInputToIso, formatCairoDateTime, formatCairoTime } from "@/lib/egyptianDate";
import { displayEgyptianPhone } from "@/lib/egyptianPhoneFormatter";

type AnyRecord = Record<string, any>;
const channels = [{ id: "ALL", label: "الكل" }, { id: "WHATSAPP", label: "واتساب" }, { id: "MESSENGER", label: "ماسنجر" }, { id: "TELEGRAM", label: "تليجرام" }];
export default function AgentWorkspace() {
  const router = useRouter();
  const [user, setUser] = useState<AnyRecord | null>(null);
  const [conversations, setConversations] = useState<AnyRecord[]>([]);
  const [activeId, setActiveId] = useState("");
  const [detail, setDetail] = useState<AnyRecord | null>(null);
  const [canned, setCanned] = useState<AnyRecord[]>([]);
  const [products, setProducts] = useState<AnyRecord[]>([]);
  const [showProducts, setShowProducts] = useState(false);
  const [productFilter, setProductFilter] = useState("ALL");
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [showCanned, setShowCanned] = useState(false);
  const [presence, setPresence] = useState("ONLINE");
  const [watching, setWatching] = useState(false);
  const [notice, setNotice] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [now, setNow] = useState(Date.now());
  const [savedOrder, setSavedOrder] = useState<AnyRecord | null>(null);
  const [order, setOrder] = useState({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "", referenceImageMessageId: "" });

  async function loadChats() { try { setConversations(await api("/api/conversations")); } catch { /* auth redirect is handled by the session bootstrap */ } }
  async function openChat(id: string) {
    if (activeId && activeId !== id) socket?.emit("conversation:leave", activeId);
    if (activeId !== id) setOrder({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "", referenceImageMessageId: "" });
    setActiveId(id); setNotice("");
    try { setDetail(await api(`/api/conversations/${id}`)); setSavedOrder(null); socket?.emit("conversation:join", id); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر فتح المحادثة"); }
  }

  useEffect(() => {
    if (!getToken()) return router.replace("/login");
    let connection: Socket | undefined;
    api("/api/auth/me").then(async (profile) => {
      if (profile.role !== "AGENT") return router.replace("/admin/dashboard");
      setUser(profile); setPresence(profile.presence);
      const [chats, replies, catalog] = await Promise.all([api("/api/conversations"), api("/api/canned-responses"), api("/api/products")]);
      setConversations(chats); setCanned(replies); setProducts(catalog);
      if (chats.length) { setActiveId(chats[0].id); setDetail(await api(`/api/conversations/${chats[0].id}`)); }
      connection = io(API_URL, { auth: { token: getToken() } }); setSocket(connection);
      if (chats.length) connection.emit("conversation:join", chats[0].id);
      connection.on("conversation:assigned", () => loadChats());
      connection.on("message:new", (event) => {
        loadChats();
        const conversationId = event.conversationId || event.conversation?.id;
        if (event.message && conversationId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: [...(old.messages || []), event.message], customer: event.customer || old.customer } : old);
      });
      connection.on("message:transcribed", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((item: AnyRecord) => item.id === event.message.id ? event.message : item) } : old));
      connection.on("whisper:new", (note) => { setDetail((old: AnyRecord) => old ? { ...old, whisperNotes: [...(old.whisperNotes || []), note] } : old); setNotice("أرسل المدير توجيهًا سريًا جديدًا"); });
      connection.on("admin:viewing", (event) => setWatching(Boolean(event.viewing)));
      connection.on("sla:breached", () => setNotice("تنبيه: تجاوزت هذه المحادثة مهلة الرد المحددة."));
    }).catch(() => { localStorage.removeItem("bondoq_token"); router.replace("/login"); });
    return () => { connection?.disconnect(); };
  }, [router]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    if (!showProducts) return;
    api("/api/products").then(setProducts).catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحديث كتالوج المنتجات"));
  }, [showProducts]);

  const latestInbound = [...(detail?.messages || [])].reverse().find((message: AnyRecord) => message.direction === "INBOUND");
  const lastInboundAt = detail?.lastInboundAt || latestInbound?.createdAt;
  const metaChannel = detail?.channel === "MESSENGER";
  const windowRemaining = lastInboundAt ? new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000 - now : 0;
  const metaWindowOpen = !metaChannel || windowRemaining > 0;
  const expiringSoon = metaChannel && metaWindowOpen && windowRemaining < 2 * 60 * 60 * 1000;
  const referenceImage = order.referenceImageMessageId ? detail?.messages?.find((message: AnyRecord) => message.id === order.referenceImageMessageId) : null;

  async function changePresence(next: string) {
    try { const response = await api("/api/agents/me/presence", { method: "PATCH", body: JSON.stringify({ presence: next }) }); setPresence(response.presence); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الحالة"); }
  }
  async function submitReply() {
    if (!text.trim() || !activeId) return;
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل الرد."); return; }
    try { await api(`/api/conversations/${activeId}/reply`, { method: "POST", body: JSON.stringify({ text: text.trim() }) }); setText(""); setShowCanned(false); setDetail(await api(`/api/conversations/${activeId}`)); loadChats(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إرسال الرد. تحقق من إعداد ربط القناة."); }
  }
  function sendReply(event: FormEvent) { event.preventDefault(); void submitReply(); }
  async function saveOrder(event: FormEvent) {
    event.preventDefault(); if (!detail) return;
    try {
      const payload = { ...order, price: order.price ? Number(order.price) : undefined, deliveryAt: cairoInputToIso(order.deliveryAt) };
      const created = await api(`/api/conversations/${detail.id}/orders`, { method: "POST", body: JSON.stringify(payload) });
      setSavedOrder(created); setNotice("تم حفظ تفاصيل الطلب بنجاح."); setDetail(await api(`/api/conversations/${detail.id}`));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الطلب"); }
  }
  async function updateOrderStatus(id: string, status: string) {
    try {
      const result = await api(`/api/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(result.notificationDelivery === "not-sent" ? "تحدّثت حالة الطلب، لكن تعذر إشعار العميل عبر القناة." : result.notificationDelivery === "sent" ? "تحدّثت حالة الطلب وأُرسل الإشعار للعميل." : "تحدّثت حالة الطلب.");
      setDetail(await api(`/api/conversations/${activeId}`));
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة الطلب"); }
  }
  async function closeConversation() {
    if (!activeId) return;
    try { await api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) }); await loadChats(); setDetail(null); setActiveId(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إغلاق المحادثة"); }
  }
  async function resolveConversation() {
    if (!activeId) return;
    try {
      const result = await api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) });
      setNotice(result.csatDelivery === "failed" ? "تم الحل، لكن تعذر إرسال استبيان الرضا. تحقق من إعداد القناة والقالب." : result.csatDelivery === "sent" ? "تم الحل وإرسال استبيان رضا العميل." : "تم تحديث الحالة إلى تم الحل.");
      setDetail(await api(`/api/conversations/${activeId}`)); loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة المحادثة"); }
  }
  async function sendProduct(product: AnyRecord) {
    if (!activeId) return;
    try {
      const result = await api(`/api/conversations/${activeId}/products`, { method: "POST", body: JSON.stringify({ productId: product.id }) });
      setShowProducts(false);
      if (result.captionDelivery === "failed") {
        setText(`${product.name}\nالسعر: ${Number(product.price).toFixed(2)} جنيه${product.description ? `\n${product.description}` : ""}`);
        setNotice("أُرسلت الصورة؛ تعذر إرسال السعر والوصف تلقائيًا، فجهزتهما في مربع الرد للإرسال يدويًا.");
      } else setNotice(`تم إرسال ${product.name} للعميل.`);
      setDetail(await api(`/api/conversations/${activeId}`)); loadChats();
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إرسال المنتج"); }
  }
  function printOrder() {
    if (!savedOrder) { setNotice("احفظ نموذج الطلب أولًا ثم اطبع أمر التحضير."); return; }
    window.print();
  }
  async function logout() { try { await api("/api/auth/logout", { method: "POST" }); } catch { /* clear the local session even if the API is unreachable */ } socket?.disconnect(); localStorage.removeItem("bondoq_token"); router.replace("/login"); }

  const visible = conversations.filter((chat) => (filter === "ALL" || chat.channel === filter) && `${chat.customer?.name || "عميل"} ${chat.customer?.phone || ""} ${chat.messages?.[0]?.text || ""}`.toLowerCase().includes(search.toLowerCase()));
  const filteredCanned = canned.filter((item) => !text.startsWith("/") || item.shortcut.toLowerCase().includes(text.toLowerCase()) || item.title.includes(text.slice(1)));
  const visibleProducts = products.filter((product) => productFilter === "ALL" || product.category === productFilter);

  return <main className="agent-app h-screen min-h-[700px] overflow-hidden bg-[#f6f5f2] text-stone-800">
    <header className="flex h-[68px] items-center justify-between border-b border-stone-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#d32f2f] text-lg font-black text-[#ffc107]">ب</div><div><b className="text-sm">بندق <span className="text-stone-300">/</span> مساحة العمل</b><p className="text-[10px] text-stone-400">محادثاتك المخصصة</p></div></div>
      <div className="flex items-center gap-2"><span className="hidden text-xs font-bold text-stone-600 sm:inline">حالتك</span><div className="relative"><select value={presence} onChange={(e) => changePresence(e.target.value)} className={`h-9 appearance-none rounded-full pl-8 pr-3 text-xs font-bold outline-none ${presence === "ONLINE" ? "bg-emerald-50 text-emerald-700" : presence === "OFFLINE" ? "bg-stone-100 text-stone-500" : "bg-amber-50 text-amber-800"}`}><option value="ONLINE">متاح</option><option value="BUSY">مشغول</option><option value="BREAK">استراحة</option><option value="OFFLINE">غير متصل</option></select><span className={`absolute left-2.5 top-3 h-2 w-2 rounded-full ${presence === "ONLINE" ? "bg-emerald-500" : presence === "OFFLINE" ? "bg-stone-400" : "bg-amber-500"}`} /></div><div className="mr-2 hidden h-8 w-px bg-stone-200 sm:block" /><div className="hidden text-left sm:block"><b className="block text-xs">{user?.name || "الموظف"}</b><span className="text-[10px] text-stone-400">{department(user?.department)}</span></div><Avatar name={user?.name || "م"} /><button onClick={logout} className="mr-1 rounded-lg px-2 py-2 text-xs text-stone-400 hover:bg-stone-100" title="تسجيل الخروج"><ArrowLeft size={17} /></button></div>
    </header>

    <section className="workspace-grid grid h-[calc(100vh-68px)] min-h-[632px] grid-cols-[285px_minmax(0,1fr)_300px] gap-3 p-3 sm:gap-4 sm:p-4">
      <aside className="workspace-list panel flex min-h-0 flex-col overflow-hidden">
        <div className="px-4 pt-4"><div className="mb-3 flex items-center justify-between"><div><h1 className="font-extrabold">المحادثات</h1><p className="text-[10px] text-stone-400">{conversations.length} محادثة مسندة إليك</p></div><span className="grid h-8 min-w-8 place-items-center rounded-full bg-red-50 px-2 text-xs font-bold text-[#d32f2f]">{conversations.filter((c) => c.unreadCount).length}</span></div><label className="flex h-10 items-center gap-2 rounded-xl bg-[#f7f5f1] px-3"><Search size={15} className="text-stone-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث عن عميل..." className="w-full bg-transparent text-xs outline-none" /></label>
          <div className="soft-scroll mt-3 flex gap-1 overflow-x-auto pb-2">{channels.map((item) => <button key={item.id} onClick={() => setFilter(item.id)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${filter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>{item.label}</button>)}</div>
        </div>
        <div className="soft-scroll flex-1 overflow-y-auto border-t border-stone-100">{visible.map((chat) => <button key={chat.id} onClick={() => openChat(chat.id)} className={`flex w-full gap-3 border-b border-stone-100 px-4 py-3 text-right transition hover:bg-[#fffaf2] ${activeId === chat.id ? "bg-[#fff6e4]" : "bg-white"}`}><div className="relative"><Avatar name={chat.customer?.name || "ع"} src={chat.customer?.avatarUrl} />{chat.unreadCount > 0 && <span className="absolute -left-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#d32f2f] px-1 text-[9px] font-bold text-white">{chat.unreadCount}</span>}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-1"><b className="truncate text-xs">{chat.customer?.name || "عميل جديد"}</b><span className="shrink-0 text-[9px] text-stone-400">{ago(chat.lastMessageAt)}</span></div><div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-[10px] text-stone-400">{chat.messages?.[0]?.text || "مرفق أو رسالة"}</span><ChannelIcon channel={chat.channel} /></div>{chat.slaBreachedAt && <span className="mt-1 inline-block rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-600">تجاوزت المهلة</span>}</div></button>)}{!visible.length && <div className="px-4 py-12 text-center text-xs text-stone-400">لا توجد محادثات هنا بعد.</div>}</div>
        <div className="flex items-center justify-between border-t border-stone-100 px-4 py-3 text-[10px] text-stone-400"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> متصل بالنظام</span><span>{user?.email}</span></div>
      </aside>

      <section className="workspace-chat panel flex min-h-0 flex-col overflow-hidden bg-[#fffdf7]">
        {detail ? <>
            <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-stone-100 bg-white px-4"><div className="flex min-w-0 items-center gap-3"><Avatar name={detail.customer?.name || "ع"} src={detail.customer?.avatarUrl} /><div className="min-w-0"><h2 className="truncate text-sm font-extrabold">{detail.customer?.name || "عميل جديد"} {detail.isComplaint && <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600">شكوى</span>}</h2><div className="flex items-center gap-2 text-[10px] text-stone-400"><ChannelIcon channel={detail.channel} /> {detail.customer?.phone ? displayEgyptianPhone(detail.customer.phone) : channelName(detail.channel)} · {detail.status === "OPEN" ? "محادثة مفتوحة" : detail.status}</div></div></div><div className="flex items-center gap-1"><button onClick={() => api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "PENDING" }) }).then(() => setNotice("تم تأجيل المحادثة للمتابعة لاحقًا."))} title="تأجيل" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><Clock3 size={17} /></button><button onClick={resolveConversation} title="تم الحل وإرسال استبيان الرضا" className="grid h-9 w-9 place-items-center rounded-lg text-emerald-600 hover:bg-emerald-50"><CheckCircle2 size={17} /></button><button onClick={closeConversation} title="إغلاق المحادثة" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-emerald-50 hover:text-emerald-700"><Archive size={17} /></button><button title="خيارات" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><MoreHorizontal size={18} /></button></div></div>
           {metaChannel && <div className={`flex shrink-0 items-center gap-2 px-4 py-2 text-[10px] font-bold ${!metaWindowOpen ? "bg-red-50 text-red-700" : expiringSoon ? "bg-[#FFC107]/20 text-[#8c650a]" : "bg-emerald-50 text-emerald-700"}`}><Clock3 size={14} />{metaWindowOpen ? `نافذة Meta مفتوحة · متبقي ${formatCountdown(windowRemaining)}` : "انتهت نافذة الـ24 ساعة للرد الحر"}{detail.isComplaint && <span className="mr-auto rounded-full bg-red-100 px-2 py-0.5 text-red-700">تحويل للجودة</span>}</div>}
          {watching && <div className="flex h-9 shrink-0 items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 text-[11px] font-semibold text-blue-700"><Users size={14} /> المدير يراقب هذه المحادثة معك الآن</div>}
          {notice && <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-900"><span>{notice}</span><button onClick={() => setNotice("")}><span>×</span></button></div>}
          <div className="soft-scroll flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-7">
            <div className="mx-auto rounded-full bg-white px-3 py-1 text-[9px] text-stone-400 shadow-sm">بدأت المحادثة · {formatCairoDateTime(detail.createdAt, false)}</div>
             {(detail.messages || []).map((message: AnyRecord) => <Message key={message.id} message={message} conversationId={detail.id} onUseAsCakeImage={message.direction === "INBOUND" && message.kind === "IMAGE" ? () => { setOrder((old) => ({ ...old, referenceImageMessageId: message.id })); setNotice("أُرفقت صورة العميل في نموذج الطلب."); } : undefined} />)}
            {(detail.whisperNotes || []).map((note: AnyRecord) => <div key={`whisper-${note.id}`} className="mx-auto w-full max-w-xl rounded-xl border border-[#f0d786] bg-[#fff8e1] px-4 py-3 text-xs leading-6 text-[#755916]"><div className="mb-1 flex items-center gap-1.5 font-extrabold"><CakeSlice size={14} /> توجيه سري من {note.author?.name || "المدير"}<span className="mr-auto text-[9px] font-normal text-[#aa8a36]">{ago(note.createdAt)}</span></div>{note.text}</div>)}
            <div className="mt-auto" />
          </div>
          <div className="relative shrink-0 border-t border-stone-100 bg-white p-3 sm:p-4">
            {!metaWindowOpen && detail.channel === "MESSENGER" && <div className="mb-3 rounded-xl border border-red-100 bg-red-50 p-3 text-[10px] leading-5 text-red-700">انتهت نافذة رد Messenger. يجب أن يرسل العميل رسالة جديدة قبل استئناف الردود الحرة.</div>}
            {showCanned && <div className="soft-scroll absolute bottom-[calc(100%-4px)] right-4 z-10 max-h-60 w-[min(340px,calc(100%-32px))] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-xl">{filteredCanned.map((reply) => <button key={reply.id} onClick={() => { setText(reply.content); setShowCanned(false); }} className="flex w-full flex-col rounded-xl px-3 py-2 text-right hover:bg-[#fff8e9]"><b className="text-xs text-[#b71c1c]">{reply.shortcut} <span className="font-medium text-stone-500">· {reply.title}</span></b><span className="mt-1 line-clamp-2 text-[10px] leading-5 text-stone-400">{reply.content}</span></button>)}{!filteredCanned.length && <p className="px-3 py-4 text-xs text-stone-400">لا يوجد رد مطابق</p>}</div>}
            <form onSubmit={sendReply}><div className="rounded-2xl border border-stone-200 bg-white focus-within:border-[#e4b8a8] focus-within:shadow-[0_0_0_3px_rgba(211,47,47,.05)]"><textarea rows={2} value={text} disabled={!metaWindowOpen} onChange={(e) => { setText(e.target.value); setShowCanned(e.target.value.startsWith("/")); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !showCanned) { e.preventDefault(); void submitReply(); } }} placeholder={metaWindowOpen ? "اكتب ردك هنا... اكتب / للردود الجاهزة" : "الرد الحر مقفل حتى يرد العميل"} className="max-h-32 min-h-[62px] w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-stone-300 disabled:cursor-not-allowed disabled:bg-stone-50" />
                <div className="flex flex-wrap items-center justify-between gap-1 border-t border-stone-100 px-2 py-2"><div className="flex items-center gap-1"><button type="button" disabled={!metaWindowOpen} title="ردود جاهزة" onClick={() => { setText(text.startsWith("/") ? text : "/"); setShowCanned(!showCanned); }} className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-[#bd8e21] hover:bg-amber-50 disabled:opacity-40">/ رد جاهز</button><button type="button" disabled={!metaWindowOpen} onClick={() => setShowProducts(true)} className="flex items-center gap-1 rounded-lg bg-[#fff8e9] px-2 py-1.5 text-[10px] font-bold text-[#9b7219] disabled:opacity-40"><CakeSlice size={14} /> إرسال منتج</button><button type="button" title="إرفاق صورة" onClick={() => setNotice("إرفاق وسائط جديدة يحتاج إعداد تخزين ملفات وربطه بمزود القناة.")} className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><Paperclip size={16} /></button><button type="button" title="إضافة موقع" onClick={() => setNotice("إرسال الموقع متاح من واجهة API بعد تحديد الإحداثيات.")} className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><MapPin size={16} /></button></div><button disabled={!text.trim() || !metaWindowOpen} className="flex h-9 items-center gap-2 rounded-xl bg-[#d32f2f] px-4 text-xs font-bold text-white shadow-sm shadow-red-200 transition hover:bg-[#b71c1c] disabled:cursor-not-allowed disabled:opacity-40"><span className="hidden sm:inline">إرسال</span><Send size={15} /></button></div>
              </div></form><p className="mt-2 text-center text-[9px] text-stone-400">Enter للإرسال · Shift + Enter لسطر جديد · رسائل العملاء تمر عبر القناة الأصلية</p>
          </div>
        </> : <div className="grid flex-1 place-items-center text-center"><div><div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-[#fff2dd] text-[#c38f22]"><MessageCircle size={28} /></div><h2 className="mt-4 font-extrabold">اختر محادثة للبدء</h2><p className="mt-1 text-xs text-stone-400">ستظهر لك الرسائل وتفاصيل العميل هنا.</p></div></div>}
      </section>

      <aside className="workspace-profile panel soft-scroll flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        {detail ? <>
          <div className="flex items-center justify-between"><h2 className="text-sm font-extrabold">ملف العميل</h2><button className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100"><MoreHorizontal size={17} /></button></div>
          <div className="rounded-2xl bg-[#fff8e9] p-4 text-center"><AvatarLarge name={detail.customer?.name || "ع"} src={detail.customer?.avatarUrl} /><h3 className="mt-3 font-extrabold">{detail.customer?.name || "عميل جديد"}</h3><p className="mt-1 text-[10px] text-stone-400">عميل منذ {formatCairoDateTime(detail.customer?.createdAt || detail.createdAt, false)}</p><div className="mt-3 flex justify-center gap-2"><button className="grid h-9 w-9 place-items-center rounded-xl bg-white text-stone-500"><Phone size={15} /></button><button className="grid h-9 w-9 place-items-center rounded-xl bg-white text-stone-500"><MessageCircle size={15} /></button></div></div>
            <div className="grid grid-cols-2 gap-2"><Info label="الهاتف" value={displayEgyptianPhone(detail.customer?.phone)} /><Info label="القناة" value={channelName(detail.channel)} /></div>
           <div className="flex items-center justify-between rounded-xl border border-[#f0e7d6] bg-[#fffdf7] px-3 py-2"><div><b className="text-[11px]">أمر تحضير</b><p className="text-[9px] text-stone-400">احفظ الطلب ثم اطبعه أو صدّره PDF</p></div><button type="button" onClick={printOrder} className="flex items-center gap-1 rounded-lg bg-[#d32f2f] px-2.5 py-2 text-[9px] font-bold text-white"><Printer size={13} /> طباعة</button></div>
            {referenceImage && <div className="rounded-xl border border-amber-100 bg-amber-50 p-2"><div className="mb-1 flex items-center justify-between text-[9px] font-bold text-amber-900"><span>صورة التورتة المرفقة</span><button type="button" onClick={() => setOrder((old) => ({ ...old, referenceImageMessageId: "" }))} className="text-red-600">إزالة</button></div><ProtectedMedia conversationId={detail.id} message={referenceImage} /></div>}
            <label className="block text-[10px] font-bold text-stone-500">السعر بالجنيه المصري<input type="number" min="0" step="0.01" value={order.price} onChange={(e) => setOrder({ ...order, price: e.target.value })} placeholder="اختياري" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label>
          <div className="border-t border-stone-100 pt-3"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-extrabold">طلب حلويات جديد</h3><span className="rounded-full bg-amber-50 px-2 py-1 text-[9px] font-bold text-amber-700">مسودة</span></div><form onSubmit={saveOrder} className="space-y-2.5"><label className="block text-[10px] font-bold text-stone-500">الصنف<input value={order.product} onChange={(e) => setOrder({ ...order, product: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label><div className="grid grid-cols-2 gap-2"><label className="text-[10px] font-bold text-stone-500">الحجم<input value={order.size} onChange={(e) => setOrder({ ...order, size: e.target.value })} placeholder="مثال: 2 كجم" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="text-[10px] font-bold text-stone-500">الحشوة<input value={order.filling} onChange={(e) => setOrder({ ...order, filling: e.target.value })} placeholder="شوكولاتة" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label></div><label className="block text-[10px] font-bold text-stone-500">العبارة على التورتة<input value={order.cakeMessage} onChange={(e) => setOrder({ ...order, cakeMessage: e.target.value })} placeholder="كل عام وأنت بخير" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">موعد التسليم<input type="datetime-local" value={order.deliveryAt} onChange={(e) => setOrder({ ...order, deliveryAt: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-[10px] font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">عنوان التوصيل<input value={order.deliveryAddress} onChange={(e) => setOrder({ ...order, deliveryAddress: e.target.value })} placeholder="المدينة، الشارع..." className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#d32f2f] text-xs font-bold text-white hover:bg-[#b71c1c]"><Check size={14} /> حفظ الطلب</button></form></div>
          {!!detail.customer?.orders?.length && <div className="border-t border-stone-100 pt-3"><h3 className="mb-2 text-xs font-extrabold">آخر الطلبات</h3>{detail.customer.orders.slice(0, 3).map((item: AnyRecord) => <div key={item.id} className="mb-2 rounded-xl bg-stone-50 px-3 py-2 text-[10px]"><div className="font-bold">{item.product || "طلب حلويات"}</div><div className="mt-1 flex items-center justify-between gap-2 text-stone-400"><span>{orderStatus(item.status)} · {ago(item.createdAt)}</span>{item.status !== "DELIVERED" && item.status !== "COMPLETED" && item.status !== "CANCELLED" && <select aria-label="تحديث حالة الطلب" value={item.status} onChange={(e) => updateOrderStatus(item.id, e.target.value)} className="max-w-32 rounded-lg border border-stone-200 bg-white px-2 py-1 font-bold text-[#b71c1c]"><option value="DRAFT">مسودة</option><option value="CONFIRMED">مؤكد</option><option value="PREPARING">قيد التجهيز</option><option value="OUT_FOR_DELIVERY">خرج للتوصيل</option><option value="DELIVERED">تم التسليم</option><option value="CANCELLED">إلغاء الطلب</option></select>}</div></div>)}</div>}
          <div className="mt-auto flex items-center gap-2 rounded-xl border border-dashed border-stone-200 p-3 text-[10px] leading-5 text-stone-400"><Clock3 size={16} className="shrink-0" /> بيانات العميل وطلباته محفوظة بشكل آمن ضمن سجل المحادثة.</div>
        </> : <div className="grid flex-1 place-items-center text-center text-xs text-stone-400"><div><UserRound size={25} className="mx-auto text-stone-300" /><p className="mt-2">ملف العميل سيظهر هنا</p></div></div>}
      </aside>
    </section>
    {showProducts && <div className="fixed inset-0 z-40 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowProducts(false)}><section className="panel max-h-[90vh] w-full max-w-3xl overflow-y-auto p-4 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-extrabold">كتالوج حلواني بندق</h2><p className="text-xs text-stone-400">اختر صنفًا لإرسال صورته وسعره للعميل</p></div><button onClick={() => setShowProducts(false)} className="rounded-lg px-3 py-1 text-xl text-stone-400">×</button></div><div className="mb-4 flex gap-2 overflow-x-auto">{[{ id: "ALL", label: "الكل" }, { id: "EASTERN", label: "شرقي" }, { id: "WESTERN", label: "غربي" }, { id: "CAKES", label: "تورتات" }].map((item) => <button key={item.id} onClick={() => setProductFilter(item.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${productFilter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500"}`}>{item.label}</button>)}</div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleProducts.map((product) => <article key={product.id} className="overflow-hidden rounded-2xl border border-stone-100 bg-white">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-36 w-full object-cover" /> : <div className="grid h-36 place-items-center bg-[#fff6e5] text-[#bd8e21]"><CakeSlice size={38} /></div>}<div className="p-3"><div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-extrabold">{product.name}</h3><p className="mt-1 text-[10px] text-stone-400">{categoryLabel(product.category)}</p></div><b className="shrink-0 text-xs text-[#a57a1c]">{Number(product.price).toFixed(2)} ج.م</b></div>{product.description && <p className="mt-2 line-clamp-2 text-[10px] leading-5 text-stone-500">{product.description}</p>}<button disabled={!product.imageUrl} onClick={() => sendProduct(product)} className="mt-3 w-full rounded-xl bg-[#d32f2f] px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-stone-300">{product.imageUrl ? "إرسال هذا المنتج" : "أضف صورة المنتج أولًا"}</button></div></article>)}</div>{!visibleProducts.length && <div className="py-12 text-center text-sm text-stone-400">لا توجد منتجات في هذا القسم.</div>}</section></div>}
    {savedOrder && detail && <section className="print-ticket" dir="rtl"><h1>حلواني بندق · أمر تحضير</h1><div className="ticket-rule" /><p><b>رقم الطلب:</b> {savedOrder.id}</p><p><b>العميل:</b> {detail.customer?.name || "غير مسجل"}</p><p><b>الهاتف:</b> {detail.customer?.phone || "غير متوفر"}</p><div className="ticket-rule" /><p><b>الصنف:</b> {savedOrder.product || "تورتة"}</p><p><b>الحجم:</b> {savedOrder.size || "—"}　 <b>الحشوة:</b> {savedOrder.filling || "—"}</p><p><b>السعر:</b> {savedOrder.price ? `${Number(savedOrder.price).toFixed(2)} جنيه مصري` : "غير محدد"}</p><p><b>العبارة:</b> {savedOrder.cakeMessage || "—"}</p><p><b>التسليم:</b> {formatCairoDateTime(savedOrder.deliveryAt)}</p><p><b>العنوان:</b> {savedOrder.deliveryAddress || "—"}</p><p><b>ملاحظات:</b> {savedOrder.notes || "—"}</p>{referenceImage && <div className="ticket-image"><ProtectedMedia conversationId={detail.id} message={referenceImage} /></div>}<div className="ticket-rule" /><p className="ticket-footer">يُسلّم إلى قسم الإنتاج · {formatCairoDateTime(new Date())}</p></section>}
  </main>;
}

function Avatar({ name, src }: { name: string; src?: string }) { return <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffe3cd] to-[#ffedb4] font-bold text-[#965a36]">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function AvatarLarge({ name, src }: { name: string; src?: string }) { return <span className="mx-auto grid h-16 w-16 place-items-center overflow-hidden rounded-[22px] bg-white text-2xl font-extrabold text-[#b67739] shadow-sm">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl bg-stone-50 p-2.5"><p className="text-[9px] text-stone-400">{label}</p><p className="mt-1 truncate text-[10px] font-bold text-stone-700" dir="auto">{value}</p></div>; }
function ChannelIcon({ channel }: { channel: string }) { const config: Record<string, { label: string; className: string }> = { WHATSAPP: { label: "W", className: "bg-emerald-100 text-emerald-700" }, MESSENGER: { label: "M", className: "bg-blue-100 text-blue-700" }, TELEGRAM: { label: "T", className: "bg-sky-100 text-sky-700" } }; const item = config[channel] || config.WHATSAPP; return <span title={channelName(channel)} className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md text-[9px] font-black ${item.className}`}>{item.label}</span>; }
function Message({ message, conversationId, onUseAsCakeImage }: { message: AnyRecord; conversationId: string; onUseAsCakeImage?: () => void }) {
  const outgoing = message.direction === "OUTBOUND";
  const hasMedia = ["IMAGE", "AUDIO", "FILE"].includes(message.kind);
  return <div className={`flex ${outgoing ? "justify-start" : "justify-end"}`}><div className={`max-w-[82%] rounded-2xl px-4 py-3 shadow-sm ${outgoing ? "rounded-tr-sm bg-white" : "rounded-tl-sm bg-[#fff0d1]"}`}>
    {hasMedia && (message.kind === "IMAGE" && outgoing && message.mediaUrl ? <img src={message.mediaUrl} alt="منتج حلواني بندق" className="mb-2 max-h-56 rounded-xl object-cover" /> : <ProtectedMedia conversationId={conversationId} message={message} />)}
    {message.kind === "AUDIO" && message.transcription && <p className="mb-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-6 text-stone-700">تفريغ صوتي: {message.transcription}</p>}
    {onUseAsCakeImage && <button onClick={onUseAsCakeImage} className="mb-2 block rounded-lg bg-white/80 px-2.5 py-1.5 text-[10px] font-bold text-[#9a7014]">إرفاق صورة التورتة بنموذج الطلب</button>}
    {message.kind === "LOCATION" ? <a className="flex items-center gap-2 text-sm text-blue-700 underline" href={`https://maps.google.com/?q=${message.latitude},${message.longitude}`} target="_blank"><MapPin size={16} /> فتح موقع العميل</a> : message.text && <p className="whitespace-pre-wrap text-sm leading-7">{message.text}</p>}
    <div className="mt-1.5 flex items-center gap-1 text-[9px] text-stone-400">{outgoing && (message.author?.name || "تم الإرسال")}{outgoing && " · "}{formatCairoTime(message.createdAt)}{outgoing && <Check size={11} className="text-emerald-600" />}</div>
  </div></div>;
}
function ProtectedMedia({ conversationId, message }: { conversationId: string; message: AnyRecord }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let objectUrl = "";
    fetch(`${API_URL}/api/conversations/${conversationId}/messages/${message.id}/media`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((response) => response.ok ? response.blob() : Promise.reject())
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }).catch(() => {});
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [conversationId, message.id]);
  if (!url) return <span className="mb-2 block text-[10px] text-stone-400">جارٍ تحميل المرفق...</span>;
  if (message.kind === "IMAGE") return <img src={url} alt="مرفق من العميل" className="mb-2 max-h-56 rounded-xl object-cover" />;
  if (message.kind === "AUDIO") return <audio controls src={url} className="mb-2 max-w-full" />;
  return <a href={url} download className="mb-2 block text-xs font-bold text-blue-700 underline">تنزيل الملف المرفق</a>;
}
function department(value?: string) { return ({ CAKES: "مبيعات التورتات", DELIVERY: "طلبات التوصيل", CUSTOMER_CARE: "خدمة العملاء", QUALITY: "قسم الجودة" } as Record<string, string>)[value || ""] || "فريق بندق"; }
function channelName(value: string) { return ({ WHATSAPP: "واتساب", MESSENGER: "ماسنجر", TELEGRAM: "تليجرام" } as Record<string, string>)[value] || value; }
function ago(value?: string) { if (!value) return "الآن"; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? "الآن" : minutes < 60 ? `منذ ${minutes} د` : `منذ ${Math.floor(minutes / 60)} س`; }
function orderStatus(value: string) { return ({ DRAFT: "مسودة", CONFIRMED: "مؤكد", PREPARING: "قيد التجهيز", OUT_FOR_DELIVERY: "خرج للتوصيل", DELIVERED: "تم التسليم", CANCELLED: "ملغي", COMPLETED: "مكتمل" } as Record<string, string>)[value] || value; }
function categoryLabel(value: string) { return ({ EASTERN: "حلويات شرقية", WESTERN: "حلويات غربية", CAKES: "تورتات" } as Record<string, string>)[value] || value; }
function formatCountdown(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`; }
