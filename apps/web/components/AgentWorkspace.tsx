"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Archive, ArrowDown, ArrowLeft, Ban, Bell, BellOff, BookUser, CakeSlice, Check, CheckCheck, CheckCircle2, Clock3, Forward, ListChecks, MapPin, MessageCircle, Mic, MicOff, MoreHorizontal, Paperclip, Pencil, Phone, PhoneCall, Pin, Printer, Reply as ReplyIcon, Search, Send, Star, Trash2, UserRound, Users, X } from "lucide-react";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { cairoInputToIso, formatCairoDateTime, formatCairoTime } from "@/lib/egyptianDate";
import { displayPhoneNumber } from "@/lib/egyptianPhoneFormatter";
import AccountSettingsModal from "./AccountSettingsModal";
import PushNotificationsButton from "./PushNotificationsButton";
import InstallAppButton from "./InstallAppButton";
import IncomingWhatsAppCallModal, { type IncomingCall } from "./IncomingWhatsAppCallModal";
import WhatsAppCallModal from "./WhatsAppCallModal";
import ProtectedMedia from "./ProtectedMedia";
import { isNotificationSoundEnabled, mergeMessages, messageNotificationPreview, playIncomingMessageTone, setNotificationSoundEnabled } from "@/lib/messageHelpers";

type AnyRecord = Record<string, any>;
const channels = [{ id: "ALL", label: "الكل" }, { id: "WHATSAPP", label: "واتساب" }, { id: "MESSENGER", label: "ماسنجر" }, { id: "TELEGRAM", label: "تليجرام" }];
const productCategoryLabel: Record<string, string> = { EASTERN: "حلويات شرقية", WESTERN: "حلويات غربية", CAKES: "تورتات", BAKERY: "مخبوزات", KAHK: "كحك وبسكويت", CHOCOLATE: "شوكولاتة", MOULID: "حلاوة المولد", OCCASIONS: "مناسبات", MIX_BONDOQ: "ميكس بندق" };
const customerDisplayName = (customer?: AnyRecord | null) => customer?.displayName?.trim() || customer?.name || "عميل جديد";
export default function AgentWorkspace() {
  const router = useRouter();
  const [user, setUser] = useState<AnyRecord | null>(null);
  const [conversations, setConversations] = useState<AnyRecord[]>([]);
  const [activeId, setActiveId] = useState("");
  const [detail, setDetail] = useState<AnyRecord | null>(null);
  const [canned, setCanned] = useState<AnyRecord[]>([]);
  const [products, setProducts] = useState<AnyRecord[]>([]);
  const [showProducts, setShowProducts] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptionsText, setPollOptionsText] = useState("");
  const [sendingPoll, setSendingPoll] = useState(false);
  const [productFilter, setProductFilter] = useState("ALL");
  const [filter, setFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [showCanned, setShowCanned] = useState(false);
  const [presence, setPresence] = useState("ONLINE");
  const [watching, setWatching] = useState(false);
  const [notice, setNotice] = useState("");
  const [incomingNotice, setIncomingNotice] = useState<AnyRecord | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [now, setNow] = useState(Date.now());
  const [savedOrder, setSavedOrder] = useState<AnyRecord | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [replyingTo, setReplyingTo] = useState<AnyRecord | null>(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState("");
  const [forwardMessage, setForwardMessage] = useState<AnyRecord | null>(null);
  const [forwardQuery, setForwardQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [favoriteCustomerIds, setFavoriteCustomerIds] = useState<string[]>([]);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [savingCustomerFavorite, setSavingCustomerFavorite] = useState(false);
  const [savingCustomerFlags, setSavingCustomerFlags] = useState(false);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [lightboxImage, setLightboxImage] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [sending, setSending] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showMobileProfile, setShowMobileProfile] = useState(false);
  const [showWhatsAppCall, setShowWhatsAppCall] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffColleagues, setHandoffColleagues] = useState<AnyRecord[]>([]);
  const [handoffBusyId, setHandoffBusyId] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [sendingProducts, setSendingProducts] = useState(false);
  const sendingRef = useRef(false);
  const detailRequest = useRef(0);
  const detailLoadingIdRef = useRef("");
  const loadingMessagesRef = useRef(new Map<string, AnyRecord[]>());
  const notifiedMessagesRef = useRef(new Set<string>());
  const chatLoadRequest = useRef(0);
  const socketRef = useRef<Socket | null>(null);
  const activeIdRef = useRef("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingCancelledRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const [order, setOrder] = useState({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "" });

  async function loadChats() {
    const request = ++chatLoadRequest.current;
    try {
      const page = await api("/api/conversations?limit=50");
      if (request === chatLoadRequest.current) {
        setConversations(page.items || []); setChatCursor(page.nextCursor || null); setHasMoreChats(Boolean(page.hasMore));
      }
    }
    catch { /* auth redirect is handled by the session bootstrap */ }
  }
  async function loadMoreChats() {
    if (!chatCursor || loadingMoreChats) return;
    const request = chatLoadRequest.current;
    setLoadingMoreChats(true);
    try {
      const params = new URLSearchParams({ limit: "50", cursor: chatCursor });
      const page = await api(`/api/conversations?${params}`);
      if (request !== chatLoadRequest.current) return;
      setConversations((current) => {
        const known = new Set(current.map((item: AnyRecord) => item.id));
        return [...current, ...(page.items || []).filter((item: AnyRecord) => !known.has(item.id))];
      });
      setChatCursor(page.nextCursor || null); setHasMoreChats(Boolean(page.hasMore));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل محادثات إضافية"); }
    finally { setLoadingMoreChats(false); }
  }
  async function openChat(id: string) {
    if (activeIdRef.current && activeIdRef.current !== id) socketRef.current?.emit("conversation:leave", activeIdRef.current);
    if (detailLoadingIdRef.current && detailLoadingIdRef.current !== id) loadingMessagesRef.current.delete(detailLoadingIdRef.current);
    if (activeId !== id) { setOrder({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "" }); setSelectedProductIds([]); }
    const request = ++detailRequest.current;
    activeIdRef.current = id; detailLoadingIdRef.current = id; stickToBottom.current = true; setShowJumpToBottom(false); setShowMobileProfile(false); setActiveId(id); setDetail(null); setNotice("");
    socketRef.current?.emit("conversation:join", id);
    try {
      const conversation = await api(`/api/conversations/${id}?messageLimit=50`);
      if (request === detailRequest.current) {
        const queuedMessages = loadingMessagesRef.current.get(id) || [];
        loadingMessagesRef.current.delete(id); detailLoadingIdRef.current = "";
        setDetail({ ...conversation, messages: mergeMessages(conversation.messages || [], queuedMessages) }); setSavedOrder(null);
      }
    } catch (error) { if (request === detailRequest.current) { detailLoadingIdRef.current = ""; setNotice(error instanceof Error ? error.message : "تعذر فتح المحادثة"); } }
  }
  async function saveCustomerProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || savingCustomer) return;
    setSavingCustomer(true);
    try {
      const customer = await api(`/api/conversations/${detail.id}/customer`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: customerName.trim() || null, phone: customerPhone.trim() || null, email: customerEmail.trim() || null, notes: customerNotes.trim() || null })
      });
      setDetail((current: AnyRecord) => current?.id === detail.id ? { ...current, customer: { ...current.customer, ...customer } } : current);
      setNotice("تم حفظ بيانات العميل.");
      void loadChats();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر حفظ بيانات العميل.");
    } finally { setSavingCustomer(false); }
  }
  async function openHandoffDialog() {
    try {
      const colleagues = await api("/api/agents/customer-care-colleagues");
      setHandoffColleagues(colleagues);
      setShowHandoff(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل زملاء خدمة العملاء"); }
  }
  async function handoffToColleague(agentId: string, agentName: string) {
    if (!activeId || handoffBusyId) return;
    const conversationId = activeId;
    setHandoffBusyId(agentId);
    try {
      await api(`/api/conversations/${conversationId}/handoff`, { method: "POST", body: JSON.stringify({ agentId }) });
      setShowHandoff(false);
      socketRef.current?.emit("conversation:leave", conversationId);
      activeIdRef.current = "";
      setActiveId("");
      setDetail(null);
      setIncomingNotice({ isHandoffSent: true, conversationId, customerName: customerDisplayName(detail?.customer), channel: detail?.channel, preview: `يتابع ${agentName} هذه المحادثة الآن.` });
      void loadChats();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر تحويل المحادثة للزميل");
      void api("/api/agents/customer-care-colleagues").then(setHandoffColleagues).catch(() => {});
    }
    finally { setHandoffBusyId(""); }
  }

  async function toggleFavorite() {
    if (!activeId) return;
    const favorite = !favoriteIds.includes(activeId);
    try {
      await api(`/api/conversations/${activeId}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
      setFavoriteIds((old) => favorite ? [...old, activeId] : old.filter((id) => id !== activeId));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث المفضلة"); }
  }

  async function togglePin() {
    if (!activeId) return;
    const pinned = !pinnedIds.includes(activeId);
    try {
      await api(`/api/conversations/${activeId}/pin`, { method: "PUT", body: JSON.stringify({ pinned }) });
      setPinnedIds((current) => pinned ? [...new Set([...current, activeId])] : current.filter((id) => id !== activeId));
      setNotice(pinned ? "تم تثبيت المحادثة في قائمتك." : "تم إلغاء تثبيت المحادثة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث تثبيت المحادثة"); }
  }

  async function toggleCustomerFavorite() {
    const customerId = detail?.customer?.id;
    if (!customerId || savingCustomerFavorite) return;
    const favorite = !favoriteCustomerIds.includes(customerId);
    setSavingCustomerFavorite(true);
    try {
      await api(`/api/customers/${customerId}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
      setFavoriteCustomerIds((current) => favorite ? [...new Set([...current, customerId])] : current.filter((id) => id !== customerId));
      setNotice(favorite ? "تم حفظ العميل في جهات الاتصال المفضلة." : "تمت إزالة العميل من المفضلة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث مفضلة العميل"); }
    finally { setSavingCustomerFavorite(false); }
  }

  async function toggleCustomerFlag(flag: "isVip" | "isBlocked") {
    const customerId = detail?.customer?.id;
    if (!customerId || savingCustomerFlags) return;
    const nextValue = !detail.customer[flag];
    if (flag === "isBlocked" && nextValue && !window.confirm("حظر العميل داخل النظام؟ سيُمنع إرسال الردود، وستُحفظ رسائله الواردة للمراجعة الإدارية.")) return;
    setSavingCustomerFlags(true);
    try {
      const customer = await api(`/api/customers/${customerId}/flags`, { method: "PATCH", body: JSON.stringify({ [flag]: nextValue }) });
      setDetail((current: AnyRecord) => current?.customer?.id === customerId ? { ...current, customer: { ...current.customer, ...customer } } : current);
      setNotice(flag === "isVip" ? nextValue ? "تم تمييز العميل كـ VIP." : "أُزيل تمييز VIP." : nextValue ? "حُظر العميل داخل النظام." : "أُلغي حظر العميل.");
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة العميل"); }
    finally { setSavingCustomerFlags(false); }
  }

  async function loadOlderMessages() {
    const conversationId = detail?.id;
    const firstMessage = detail?.messages?.[0];
    if (!conversationId || !firstMessage?.id || !detail.hasMoreMessages || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    try {
      const params = new URLSearchParams({ before: firstMessage.id, limit: "50" });
      const page = await api(`/api/conversations/${conversationId}/messages?${params}`);
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: mergeMessages(current.messages || [], page.messages || []), hasMoreMessages: Boolean(page.hasMore) } : current);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل الرسائل الأقدم"); }
    finally { setLoadingOlderMessages(false); }
  }

  async function addInternalNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const conversationId = activeId;
    const noteText = internalNote.trim();
    if (!conversationId || !noteText) return;
    try {
      const note = await api(`/api/conversations/${conversationId}/notes`, { method: "POST", body: JSON.stringify({ text: noteText }) });
      setDetail((old: AnyRecord) => old?.id === conversationId && !old.internalNotes?.some((item: AnyRecord) => item.id === note.id) ? { ...old, internalNotes: [...(old.internalNotes || []), note] } : old);
      setInternalNote("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الملاحظة الداخلية"); }
  }

  async function reactToMessage(message: AnyRecord, emoji: string) {
    if (!activeId) return;
    const existing = message.reactions?.find((item: AnyRecord) => item.userId === user?.id);
    try {
      const result = existing?.emoji === emoji
        ? await api(`/api/conversations/${activeId}/messages/${message.id}/reaction`, { method: "DELETE" })
        : await api(`/api/conversations/${activeId}/messages/${message.id}/reaction`, { method: "PUT", body: JSON.stringify({ emoji }) });
      if (!result.providerSynced) setNotice("تم حفظ التفاعل داخل النظام فقط؛ القناة لا تدعم مزامنته في وضعها الحالي.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إضافة التفاعل"); }
  }

  function beginMessageEdit(message: AnyRecord) { setEditingMessageId(message.id); setEditingText(message.text || ""); }
  async function saveMessageEdit(message: AnyRecord) {
    const value = editingText.trim();
    if (!value || savingEdit) return;
    setSavingEdit(true);
    try {
      const updated = await api(`/api/conversations/${activeId}/messages/${message.id}`, { method: "PATCH", body: JSON.stringify({ text: value }) });
      setDetail((current: AnyRecord) => current?.id === activeId ? { ...current, messages: (current.messages || []).map((item: AnyRecord) => item.id === updated.id ? updated : item) } : current);
      setEditingMessageId(""); setEditingText(""); setNotice("تم تعديل الرسالة لدى القناة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تعديل الرسالة"); }
    finally { setSavingEdit(false); }
  }
  async function deleteSentMessage(message: AnyRecord) {
    if (!activeId || deletingMessageId) return;
    if (!window.confirm("حذف هذه الرسالة من المحادثة والقناة؟ لا يمكن التراجع عن الحذف.")) return;
    const conversationId = activeId;
    setDeletingMessageId(message.id);
    try {
      await api(`/api/conversations/${conversationId}/messages/${message.id}`, { method: "DELETE" });
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: (current.messages || []).filter((item: AnyRecord) => item.id !== message.id) } : current);
      setNotice("حُذفت الرسالة من المحادثة والقناة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف الرسالة"); }
    finally { setDeletingMessageId(""); }
  }
  async function forwardMessageTo(target: AnyRecord) {
    if (!forwardMessage) return;
    const source = forwardMessage;
    try {
      const sent = await api(`/api/conversations/${source.conversationId}/messages/${source.id}/forward`, { method: "POST", body: JSON.stringify({ targetConversationId: target.id }) });
      setDetail((current: AnyRecord) => current?.id === target.id ? { ...current, messages: mergeMessages(current.messages || [], sent) } : current);
      setForwardMessage(null); setForwardQuery("");
      setNotice(`تم تحويل الرسالة إلى ${customerDisplayName(target.customer)}.`);
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحويل الرسالة"); }
  }
  async function createPoll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); return; }
    if (sendingPoll) return;
    const options = pollOptionsText.split(/\r?\n/).map((option) => option.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 10) { setNotice("أضف خيارين إلى عشرة خيارات للاستطلاع."); return; }
    setSendingPoll(true);
    try {
      const message = await api(`/api/conversations/${activeId}/poll`, { method: "POST", body: JSON.stringify({ question: pollQuestion.trim(), options }) });
      setDetail((current: AnyRecord) => current?.id === activeId ? { ...current, messages: mergeMessages(current.messages || [], message) } : current);
      setPollQuestion(""); setPollOptionsText(""); setShowPollComposer(false); setNotice(message.deliveryStatus === "FAILED" ? "تعذر إرسال الاستطلاع." : "تم إرسال الاستطلاع.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إرسال الاستطلاع"); }
    finally { setSendingPoll(false); }
  }

  useEffect(() => {
    if (!getToken()) return router.replace("/login");
    let connection: Socket | undefined;
    let current = true;
    const initialize = async () => {
      const profile = await api("/api/auth/me");
      if (!current) return;
      if (profile.role !== "AGENT" && profile.role !== "BRANCH_USER") return router.replace("/admin/dashboard");
      setUser(profile); setPresence(profile.presence);
      connection = io(API_URL, { auth: { token: getToken() } }); socketRef.current = connection; setSocket(connection);
      connection.on("connect", () => { void loadChats(); if (activeIdRef.current) void openChat(activeIdRef.current); });
      connection.on("canned:updated", () => { void api("/api/canned-responses").then(setCanned).catch(() => {}); });
      connection.on("presence:updated", () => {
        if (profile.role === "AGENT" && profile.department === "CUSTOMER_CARE") {
          void api("/api/agents/customer-care-colleagues").then(setHandoffColleagues).catch(() => {});
        }
      });
      connection.on("customer:updated", (event) => {
        if (event.conversationId) {
          setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, customer: { ...old.customer, ...event.customer } } : old);
          void loadChats();
        }
      });
      connection.on("conversation-note:new", (event) => {
        if (event.conversationId) setDetail((old: AnyRecord) => old?.id === event.conversationId && !old.internalNotes?.some((note: AnyRecord) => note.id === event.note.id) ? { ...old, internalNotes: [...(old.internalNotes || []), event.note] } : old);
      });
      connection.on("customer:tags-updated", (event) => {
        setDetail((old: AnyRecord) => old?.customer?.id === event.customerId ? { ...old, customer: { ...old.customer, tags: event.tags } } : old);
        void loadChats();
      });
       connection.on("message:reaction", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((message: AnyRecord) => message.id === event.messageId ? { ...message, reactions: [...(message.reactions || []).filter((reaction: AnyRecord) => reaction.userId !== event.reaction.userId), event.reaction] } : message) } : old));
       connection.on("message:reaction-removed", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((message: AnyRecord) => message.id === event.messageId ? { ...message, reactions: (message.reactions || []).filter((reaction: AnyRecord) => reaction.userId !== event.userId) } : message) } : old));
        connection.on("message:updated", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((message: AnyRecord) => message.id === event.message.id ? event.message : message) } : old));
        connection.on("message:deleted", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).filter((message: AnyRecord) => message.id !== event.messageId) } : old));
        connection.on("message:status", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((message: AnyRecord) => message.id === event.message.id ? { ...message, deliveryStatus: event.message.deliveryStatus } : message) } : old));
        connection.on("conversation:deleted", (event) => {
          void loadChats();
          if (event.conversationId === activeIdRef.current) {
            socketRef.current?.emit("conversation:leave", event.conversationId);
            activeIdRef.current = ""; setActiveId(""); setDetail(null);
          }
        });
      connection.on("conversation:assigned", () => loadChats());
      connection.on("conversation:handoff", (event) => {
        void loadChats();
        setIncomingNotice({ isHandoff: true, conversationId: event.conversation.id, customerName: customerDisplayName(event.conversation.customer), channel: event.conversation.channel, preview: `حوّلها إليك ${event.fromAgentName || "زميلك"}.` });
      });
      connection.on("conversation:unassigned", (event) => {
        void loadChats();
        if (event.id === activeIdRef.current) {
          socketRef.current?.emit("conversation:leave", event.id);
          activeIdRef.current = "";
          setActiveId("");
          setDetail(null);
          setIncomingNotice({ isHandoffSent: true, conversationId: event.id, customerName: customerDisplayName(event.customer), channel: event.channel, preview: event.assignedAgent?.name ? `يتابع ${event.assignedAgent.name} هذه المحادثة الآن.` : "أُعيدت المحادثة إلى الطابور." });
        }
      });
      connection.on("message:new", (event) => {
        loadChats();
        const conversationId = event.conversationId || event.conversation?.id;
        if (event.message?.direction === "INBOUND" && conversationId) {
          const messageId = event.message.id;
          if (!messageId || !notifiedMessagesRef.current.has(messageId)) {
            if (messageId) {
              notifiedMessagesRef.current.add(messageId);
              if (notifiedMessagesRef.current.size > 100) notifiedMessagesRef.current.delete(notifiedMessagesRef.current.values().next().value!);
            }
            playIncomingMessageTone();
            setIncomingNotice({ conversationId, customerName: customerDisplayName(event.customer || event.conversation?.customer), channel: event.conversation?.channel, preview: messageNotificationPreview(event.message) });
          }
        }
        if (event.message && conversationId === detailLoadingIdRef.current) {
          loadingMessagesRef.current.set(conversationId, mergeMessages(loadingMessagesRef.current.get(conversationId) || [], event.message));
        }
        if (event.message && conversationId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], event.message), customer: event.customer || old.customer } : old);
      });
      connection.on("message:transcribed", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: mergeMessages(old.messages || [], event.message) } : old));
      connection.on("whisper:new", (note) => { setDetail((old: AnyRecord) => old ? { ...old, whisperNotes: [...(old.whisperNotes || []), note] } : old); setNotice("أرسل المدير توجيهًا سريًا جديدًا"); });
      connection.on("whatsapp:incoming-call", (call) => setIncomingCall(call));
      connection.on("whatsapp:call-ended", (event) => setIncomingCall((current) => current?.callId === event.callId ? null : current));
      connection.on("admin:viewing", (event) => setWatching(Boolean(event.viewing)));
      connection.on("sla:breached", () => setNotice("تنبيه: تجاوزت هذه المحادثة مهلة الرد المحددة."));
       const [chatPage, replies, catalog, favorites, customerFavorites, pins] = await Promise.all([api("/api/conversations?limit=50"), api("/api/canned-responses"), api("/api/products"), api("/api/conversations/favorites"), api("/api/customers/favorites"), api("/api/conversations/pins")]);
        if (!current) return;
        const chats = chatPage.items || [];
        setConversations(chats); setChatCursor(chatPage.nextCursor || null); setHasMoreChats(Boolean(chatPage.hasMore));
        setCanned(replies); setProducts(catalog); setFavoriteIds(favorites.map((item: AnyRecord) => item.id)); setPinnedIds(pins.map((item: AnyRecord) => item.id)); setFavoriteCustomerIds(customerFavorites.ids || []);
      if (chats.length && !activeIdRef.current) {
        const requestedId = new URLSearchParams(window.location.search).get("conversation");
        const requestedChat = requestedId && chats.find((chat: AnyRecord) => chat.id === requestedId);
        const id = requestedChat?.id || chats[0].id;
        if (requestedChat) window.history.replaceState(null, "", window.location.pathname);
        const request = ++detailRequest.current;
        activeIdRef.current = id; detailLoadingIdRef.current = id; setActiveId(id); connection.emit("conversation:join", id);
         const conversation = await api(`/api/conversations/${id}?messageLimit=50`);
        if (current && request === detailRequest.current) {
          const queuedMessages = loadingMessagesRef.current.get(id) || [];
          loadingMessagesRef.current.delete(id); detailLoadingIdRef.current = "";
          setDetail({ ...conversation, messages: mergeMessages(conversation.messages || [], queuedMessages) });
        }
      }
    };
    initialize().catch((reason) => {
      if (!current) return;
      if (reason instanceof ApiError && reason.status === 401) {
        localStorage.removeItem("bondoq_token");
        router.replace("/login");
      } else setNotice("تعذر الاتصال بالخادم. بقي تسجيل الدخول محفوظًا؛ أعد تحميل الصفحة عند عودة الاتصال.");
    });
    return () => { current = false; if (socketRef.current === connection) socketRef.current = null; connection?.disconnect(); };
  }, [router]);

  useEffect(() => { setSoundEnabled(isNotificationSoundEnabled()); }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") { recordingCancelledRef.current = true; recorder.stop(); }
  }, []);

  useEffect(() => {
    setCustomerName(detail?.customer?.displayName || detail?.customer?.name || "");
    setCustomerNotes(detail?.customer?.notes || "");
    setCustomerPhone(detail?.customer?.phone || "");
    setCustomerEmail(detail?.customer?.email || "");
  }, [detail?.id, detail?.customer?.displayName, detail?.customer?.name, detail?.customer?.notes, detail?.customer?.phone, detail?.customer?.email]);

  useEffect(() => {
    if (!detail || !messageEndRef.current) return;
    if (stickToBottom.current) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      setShowJumpToBottom(false);
    } else setShowJumpToBottom(true);
  }, [detail?.id, detail?.messages?.length]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    if (!showProducts) return;
    api("/api/products").then(setProducts).catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحديث كتالوج المنتجات"));
  }, [showProducts]);

  const latestInbound = [...(detail?.messages || [])].reverse().find((message: AnyRecord) => message.direction === "INBOUND");
  const lastInboundAt = detail?.lastInboundAt || latestInbound?.createdAt;
  const metaChannel = detail?.channel === "MESSENGER";
  const callTarget = detail?.customer?.phone || detail?.externalCustomerId || "";
  const windowRemaining = lastInboundAt ? new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000 - now : 0;
  const metaWindowOpen = !metaChannel || windowRemaining > 0;
  const messagingEnabled = metaWindowOpen && !detail?.customer?.isBlocked;
  const expiringSoon = metaChannel && metaWindowOpen && windowRemaining < 2 * 60 * 60 * 1000;

  async function changePresence(next: string) {
    try {
      const response = await api("/api/agents/me/presence", { method: "PATCH", body: JSON.stringify({ presence: next }) });
      setPresence(response.presence);
      if (response.presence === "OFFLINE") {
        activeIdRef.current = ""; setActiveId(""); setDetail(null); await loadChats();
      }
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الحالة"); }
  }
  async function deliverReply(payload: { text?: string; kind?: string; mediaAssetId?: string; previewUrl?: string; latitude?: number; longitude?: number; quotedMessageId?: string }, conversationId = activeId, alreadyLocked = false) {
    if (!conversationId) { if (alreadyLocked) { sendingRef.current = false; setSending(false); } return; }
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); if (alreadyLocked) { sendingRef.current = false; setSending(false); } return; }
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل الرد."); if (alreadyLocked) { sendingRef.current = false; setSending(false); } return; }
    if (!alreadyLocked && sendingRef.current) return;
    if (!alreadyLocked) { sendingRef.current = true; setSending(true); }
    const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMessage = { id: localId, conversationId, author: { name: user?.name || "أنت" }, createdAt: new Date().toISOString(), direction: "OUTBOUND", kind: payload.kind || "TEXT", text: payload.text, mediaAssetId: payload.mediaAssetId, latitude: payload.latitude, longitude: payload.longitude, quotedMessageId: payload.quotedMessageId, localPreviewUrl: payload.previewUrl, deliveryStatus: "PENDING" };
    setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], pendingMessage) } : old);
    setText((current) => current === payload.text ? "" : current);
    setShowCanned(false); setNotice("");
    try {
      const message = await api(`/api/conversations/${conversationId}/reply`, { method: "POST", body: JSON.stringify({ text: payload.text, kind: payload.kind || "TEXT", mediaAssetId: payload.mediaAssetId, latitude: payload.latitude, longitude: payload.longitude, quotedMessageId: payload.quotedMessageId }) });
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages((old.messages || []).filter((item: AnyRecord) => item.id !== localId), message) } : old);
      if (payload.quotedMessageId) setReplyingTo((old) => old?.id === payload.quotedMessageId ? null : old);
      if (message.deliveryStatus === "FAILED") setNotice("تعذر إضافة الرسالة إلى قائمة الإرسال. تحقق من اتصال WhatsApp.");
      void loadChats();
    } catch (error) {
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => item.id !== localId) } : old);
      setText((current) => current || payload.text || "");
      setNotice(error instanceof Error ? error.message : "تعذر إرسال الرد. تحقق من إعداد ربط القناة.");
    } finally {
      sendingRef.current = false; setSending(false);
      if (payload.previewUrl) URL.revokeObjectURL(payload.previewUrl);
    }
  }
  async function submitReply() {
    const message = text.trim();
    if (!message) return;
    await deliverReply({ text: message, quotedMessageId: replyingTo?.id });
  }
  function sendReply(event: FormEvent) { event.preventDefault(); void submitReply(); }
  function shareLocation() {
    if (!activeId) return;
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); return; }
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل إرسال الموقع."); return; }
    if (sendingRef.current) return;
    if (!navigator.geolocation) { setNotice("مشاركة الموقع غير متاحة في هذا المتصفح أو الاتصال."); return; }
    const conversationId = activeId;
    sendingRef.current = true;
    setSending(true);
    setNotice("جارٍ تحديد موقعك...");
    navigator.geolocation.getCurrentPosition((position) => {
      sendingRef.current = false;
      void deliverReply({ kind: "LOCATION", latitude: position.coords.latitude, longitude: position.coords.longitude }, conversationId);
    }, (error) => {
      sendingRef.current = false;
      setSending(false);
      setNotice(error.code === error.PERMISSION_DENIED ? "لم تسمح بمشاركة الموقع." : error.code === error.POSITION_UNAVAILABLE ? "تعذر تحديد الموقع من الجهاز." : "انتهت مهلة تحديد الموقع. حاول مجددًا.");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  async function uploadAndSend(file: File) {
    if (!activeId) return;
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); return; }
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل إرسال الملف."); return; }
    if (sendingRef.current) return;
    if (file.size > 12 * 1024 * 1024) { setNotice("حجم الملف الأقصى 12 ميجابايت."); return; }
    const conversationId = activeId;
     const extensionType: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: file.type.startsWith("audio/") ? "audio/webm" : "application/octet-stream", aac: "audio/aac", mp4: "video/mp4", "3gp": "video/3gpp", mov: "video/quicktime", pdf: "application/pdf", txt: "text/plain", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const contentType = (file.type || extensionType[extension] || "").split(";")[0].toLowerCase();
      const kind = contentType === "image/webp" ? "STICKER" : contentType.startsWith("image/") ? "IMAGE" : contentType.startsWith("audio/") ? "AUDIO" : contentType.startsWith("video/") ? "VIDEO" : "FILE";
      const previewUrl = ["IMAGE", "STICKER", "AUDIO", "VIDEO"].includes(kind) ? URL.createObjectURL(file) : undefined;
    sendingRef.current = true; setNotice("جارٍ رفع الملف..."); setSending(true);
    try {
      const response = await fetch(`${API_URL}/api/media`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": contentType || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const uploaded = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(uploaded.error || `تعذر رفع الملف (${response.status})`);
      setNotice("");
      await deliverReply({ text: text.trim() || undefined, kind, mediaAssetId: uploaded.id, previewUrl }, conversationId, true);
    } catch (error) {
      sendingRef.current = false; setSending(false);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setNotice(error instanceof Error ? error.message : "تعذر رفع الملف أو إرساله");
    }
  }
   async function startRecording() {
      if (recorderRef.current || !activeId || sendingRef.current) return;
      if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); return; }
     try {
       const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
       const supported = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/ogg", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
       const recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
       const chunks: Blob[] = [];
       recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
       recorder.onstop = () => {
         stream.getTracks().forEach((track) => track.stop()); recorderRef.current = null; setRecording(false);
         setRecordingSeconds(0);
         if (recordingCancelledRef.current) { recordingCancelledRef.current = false; return; }
         const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
         const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
         void uploadAndSend(new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type }));
       };
       recordingCancelledRef.current = false; recordingStartedAtRef.current = Date.now(); recorderRef.current = recorder; recorder.start(); setRecording(true); setRecordingSeconds(0); setNotice("التسجيل جارٍ. أرسل التسجيل أو ألغِه عند الانتهاء.");
     } catch { setNotice("تعذر بدء التسجيل. تحقق من إذن استخدام الميكروفون في المتصفح."); }
   }
   function sendRecording() { if (recorderRef.current?.state === "recording") recorderRef.current.stop(); }
   function cancelRecording() { if (!recorderRef.current) return; recordingCancelledRef.current = true; recorderRef.current.stop(); }
   function toggleRecording() { if (recording) sendRecording(); else void startRecording(); }
   async function rejectIncomingWhatsAppCall() {
     if (!incomingCall) return;
     const call = incomingCall;
     await api("/api/integrations/whatsapp/calls/reject", { method: "POST", body: JSON.stringify({ callId: call.callId, callerJid: call.callerJid }) });
     setIncomingCall(null);
     if (call.conversationId) await openChat(call.conversationId);
     setNotice("رُفضت المكالمة وأُرسل الرد التلقائي عبر WhatsApp.");
   }
   function openIncomingCallConversation() {
     if (!incomingCall?.conversationId) return;
     const id = incomingCall.conversationId; setIncomingCall(null); void openChat(id);
   }
  async function saveOrder(event: FormEvent) {
    event.preventDefault(); if (!detail) return;
    try {
      const payload = { ...order, price: order.price ? Number(order.price) : undefined, deliveryAt: cairoInputToIso(order.deliveryAt) };
      const created = await api(`/api/conversations/${detail.id}/orders`, { method: "POST", body: JSON.stringify(payload) });
      setSavedOrder(created); setNotice("تم حفظ تفاصيل الطلب بنجاح."); setDetail(await api(`/api/conversations/${detail.id}?messageLimit=50`));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ الطلب"); }
  }
  async function updateOrderStatus(id: string, status: string) {
    try {
      const result = await api(`/api/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(result.notificationDelivery === "not-sent" ? "تحدّثت حالة الطلب، لكن تعذر إشعار العميل عبر القناة." : result.notificationDelivery === "sent" ? "تحدّثت حالة الطلب وأُرسل الإشعار للعميل." : "تحدّثت حالة الطلب.");
      setDetail(await api(`/api/conversations/${activeId}?messageLimit=50`));
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة الطلب"); }
  }
  async function closeConversation() {
    if (!activeId) return;
    try { await api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) }); ++detailRequest.current; detailLoadingIdRef.current = ""; loadingMessagesRef.current.delete(activeId); socketRef.current?.emit("conversation:leave", activeId); activeIdRef.current = ""; await loadChats(); setDetail(null); setActiveId(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إغلاق المحادثة"); }
  }
  async function resolveConversation() {
    if (!activeId) return;
    try {
      const result = await api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) });
      setNotice(result.csatDelivery === "failed" ? "تم الحل، لكن تعذر إرسال استبيان الرضا. تحقق من إعداد القناة والقالب." : result.csatDelivery === "sent" ? "تم الحل وإرسال استبيان رضا العميل." : "تم تحديث الحالة إلى تم الحل.");
      setDetail(await api(`/api/conversations/${activeId}?messageLimit=50`)); loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة المحادثة"); }
  }
  async function sendSelectedProducts(productIds = selectedProductIds) {
    if (!activeId || !productIds.length || sendingProducts) return;
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال منتجات."); return; }
    const conversationId = activeId;
    const selected = products.filter((product) => productIds.includes(product.id));
    const pendingIds = selected.map((product, index) => `pending-product-${Date.now()}-${index}`);
    const pending = selected.map((product, index) => ({ id: pendingIds[index], conversationId, author: { name: user?.name || "أنت" }, createdAt: new Date().toISOString(), direction: "OUTBOUND", kind: "TEXT", text: `${product.name}\nالسعر: ${Number(product.price).toFixed(2)} جنيه`, deliveryStatus: "PENDING" }));
    setSendingProducts(true);
    setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], pending) } : old);
    try {
      const result = await api(`/api/conversations/${conversationId}/products`, { method: "POST", body: JSON.stringify({ productIds }) });
      setShowProducts(false);
      setSelectedProductIds([]);
      const failedImages = result.items?.filter((item: AnyRecord) => item.captionDelivery !== "failed" && item.imageDelivery === "failed") || [];
      const failedCaptions = result.items?.filter((item: AnyRecord) => item.captionDelivery === "failed") || [];
      const queuedCount = result.items?.filter((item: AnyRecord) => item.captionDelivery === "queued" || item.imageDelivery === "queued").length || 0;
      setNotice(failedCaptions.length ? `تعذر إرسال تفاصيل ${failedCaptions.length} من المنتجات المحددة.` : failedImages.length ? `وصلت تفاصيل المنتجات، وتعذر إرسال صورة ${failedImages.length} منها.` : queuedCount ? `أُضيفت ${result.items?.length || selected.length} منتجات إلى قائمة إرسال WhatsApp في الخلفية.` : `تم إرسال ${result.items?.length || selected.length} منتجات مع صورها.`);
      const sentMessages = (result.items || []).flatMap((item: AnyRecord) => [item.textMessage, item.imageMessage].filter(Boolean));
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages((old.messages || []).filter((item: AnyRecord) => !pendingIds.includes(item.id)), sentMessages) } : old);
      void loadChats();
    }
    catch (error) {
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => !pendingIds.includes(item.id)) } : old);
      setNotice(error instanceof Error ? error.message : "تعذر إرسال المنتجات المحددة");
    } finally { setSendingProducts(false); }
  }
  function toggleProductSelection(productId: string) {
    if (selectedProductIds.includes(productId)) setSelectedProductIds((current) => current.filter((id) => id !== productId));
    else if (selectedProductIds.length >= 12) setNotice("يمكن اختيار 12 منتجًا كحد أقصى في الإرسال الواحد.");
    else setSelectedProductIds((current) => [...current, productId]);
  }
  function printOrder() {
    if (!savedOrder) { setNotice("احفظ نموذج الطلب أولًا ثم اطبع أمر التحضير."); return; }
    window.print();
  }
  async function logout() { try { await api("/api/auth/logout", { method: "POST" }); } catch { /* clear the local session even if the API is unreachable */ } socket?.disconnect(); localStorage.removeItem("bondoq_token"); router.replace("/login"); }

  const visible = conversations.filter((chat) => {
    const statusMatches = statusFilter === "ALL" || (statusFilter === "FAVORITES" ? favoriteIds.includes(chat.id) : statusFilter === "PINNED" ? pinnedIds.includes(chat.id) : statusFilter === "ACTIVE" ? ["OPEN", "PENDING", "QUEUED"].includes(chat.status) : chat.status === statusFilter);
    return statusMatches && (filter === "ALL" || chat.channel === filter) && `${customerDisplayName(chat.customer)} ${chat.customer?.phone || ""} ${chat.messages?.[0]?.text || ""}`.toLowerCase().includes(search.toLowerCase());
  });
  const filteredCanned = canned.filter((item) => !text.startsWith("/") || item.shortcut.toLowerCase().includes(text.toLowerCase()) || item.title.includes(text.slice(1)));
  const visibleProducts = products.filter((product) => productFilter === "ALL" || product.category === productFilter);

  return <main className="agent-app h-screen min-h-[700px] overflow-hidden bg-[#f6f5f2] text-stone-800">
    <header className="flex h-[68px] items-center justify-between border-b border-stone-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#d32f2f] text-lg font-black text-[#ffc107]">ب</div><div><b className="text-sm">حلواني بندق</b><p className="text-[10px] text-stone-400">مساحة العمل · محادثاتك المخصصة</p></div></div>
      <div className="flex items-center gap-1 sm:gap-2"><span className="hidden text-xs font-bold text-stone-600 sm:inline">حالتك</span><div className="relative"><select value={presence} onChange={(e) => changePresence(e.target.value)} className={`h-9 appearance-none rounded-full pl-8 pr-3 text-xs font-bold outline-none ${presence === "ONLINE" ? "bg-emerald-50 text-emerald-700" : presence === "OFFLINE" ? "bg-stone-100 text-stone-500" : "bg-amber-50 text-amber-800"}`}><option value="ONLINE">متاح</option><option value="BUSY">مشغول</option><option value="BREAK">استراحة</option><option value="OFFLINE">غير متصل</option></select><span className={`absolute left-2.5 top-3 h-2 w-2 rounded-full ${presence === "ONLINE" ? "bg-emerald-500" : presence === "OFFLINE" ? "bg-stone-400" : "bg-amber-500"}`} /></div><PushNotificationsButton /><InstallAppButton /><button type="button" onClick={() => router.push("/contacts")} title="جهات الاتصال ودليل الشركة" aria-label="جهات الاتصال ودليل الشركة" className="grid h-9 w-9 place-items-center rounded-lg text-stone-500 hover:bg-amber-50 hover:text-amber-700"><BookUser size={17} /></button><button type="button" aria-label={soundEnabled ? "إيقاف صوت الرسائل" : "تشغيل صوت الرسائل"} title={soundEnabled ? "إيقاف صوت الرسائل الجديدة" : "تشغيل صوت الرسائل الجديدة"} onClick={() => { const next = !soundEnabled; setSoundEnabled(next); setNotificationSoundEnabled(next); }} className={`grid h-9 w-9 place-items-center rounded-lg ${soundEnabled ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100"}`}>{soundEnabled ? <Bell size={17} /> : <BellOff size={17} />}</button><div className="mr-2 hidden h-8 w-px bg-stone-200 sm:block" /><div className="hidden text-left sm:block"><b className="block text-xs">{user?.name || "الموظف"}</b><span className="text-[10px] text-stone-400">{department(user?.department)}</span></div><Avatar name={user?.name || "م"} /><button onClick={() => setShowAccount(true)} className="rounded-lg p-2 text-stone-400 hover:bg-amber-50 hover:text-amber-700" title="إعدادات الحساب"><UserRound size={17} /></button><button onClick={logout} className="mr-1 rounded-lg px-2 py-2 text-xs text-stone-400 hover:bg-stone-100" title="تسجيل الخروج"><ArrowLeft size={17} /></button></div>
    </header>

      {incomingNotice && <div role="status" aria-live="polite" className="fixed left-3 right-3 top-[76px] z-50 ml-auto flex max-w-sm items-center gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-xl sm:left-auto sm:right-6"><div className="min-w-0 flex-1"><p className="text-xs font-extrabold text-emerald-900">{incomingNotice.isHandoffSent ? "تم تحويل المحادثة" : incomingNotice.isHandoff ? "محادثة محولة إليك" : `رسالة جديدة من ${incomingNotice.customerName}`}</p><p className="mt-1 text-[10px] text-stone-400">{incomingNotice.channel ? channelName(incomingNotice.channel) : "رسالة واردة"}</p><p className="mt-1 line-clamp-2 text-xs text-stone-600">{incomingNotice.preview}</p></div>{!incomingNotice.isHandoffSent && <button type="button" onClick={() => { const id = incomingNotice.conversationId; setIncomingNotice(null); void openChat(id); }} className="shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-[10px] font-bold text-white">عرض المحادثة</button>}<button type="button" onClick={() => setIncomingNotice(null)} aria-label="إغلاق التنبيه" className="shrink-0 rounded-lg p-1 text-stone-400 hover:bg-stone-100">×</button></div>}

    <section data-chat-open={Boolean(activeId)} className="workspace-grid grid h-[calc(100vh-68px)] min-h-[632px] grid-cols-[285px_minmax(0,1fr)_300px] gap-3 p-3 sm:gap-4 sm:p-4">
      <aside className="workspace-list panel flex min-h-0 flex-col overflow-hidden">
        <div className="px-4 pt-4"><div className="mb-3 flex items-center justify-between"><div><h1 className="font-extrabold">المحادثات</h1><p className="text-[10px] text-stone-400">{conversations.length} محادثة مسندة إليك</p></div><span className="grid h-8 min-w-8 place-items-center rounded-full bg-red-50 px-2 text-xs font-bold text-[#d32f2f]">{conversations.filter((c) => c.unreadCount).length}</span></div><label className="flex h-10 items-center gap-2 rounded-xl bg-[#f7f5f1] px-3"><Search size={15} className="text-stone-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث عن عميل..." className="w-full bg-transparent text-xs outline-none" /></label>
           <div className="soft-scroll mt-3 flex gap-1 overflow-x-auto pb-2">{channels.map((item) => <button key={item.id} onClick={() => setFilter(item.id)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${filter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>{item.label}</button>)}</div>
            <div className="soft-scroll flex gap-1 overflow-x-auto pb-3">{[{ id: "ACTIVE", label: "نشطة" }, { id: "FAVORITES", label: "المفضلة" }, { id: "PINNED", label: "المثبتة" }, { id: "RESOLVED", label: "تم الحل" }, { id: "CLOSED", label: "مؤرشفة" }, { id: "ALL", label: "الكل" }].map((item) => <button key={item.id} onClick={() => setStatusFilter(item.id)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${statusFilter === item.id ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>{item.label}</button>)}</div>
        </div>
          <div className="soft-scroll flex-1 overflow-y-auto border-t border-stone-100">{visible.map((chat) => <button key={chat.id} onClick={() => openChat(chat.id)} className={`flex w-full gap-3 border-b border-stone-100 px-4 py-3 text-right transition hover:bg-[#fffaf2] ${activeId === chat.id ? "bg-[#fff6e4]" : "bg-white"}`}><div className="relative"><Avatar name={customerDisplayName(chat.customer)} src={chat.customer?.avatarUrl} />{chat.unreadCount > 0 && <span className="absolute -left-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#d32f2f] px-1 text-[9px] font-bold text-white">{chat.unreadCount}</span>}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-1"><b className="truncate text-xs">{customerDisplayName(chat.customer)}</b><span className="shrink-0 text-[9px] text-stone-400">{ago(chat.lastMessageAt)}</span></div><div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-[10px] text-stone-400">{chat.messages?.[0]?.text || "مرفق أو رسالة"}</span><ChannelIcon channel={chat.channel} /></div>{chat.serviceTag && <span className="mt-1 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">{chat.serviceTag}</span>}{chat.slaBreachedAt && <span className="mt-1 mr-1 inline-block rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-600">تجاوزت المهلة</span>}</div></button>)}{!visible.length && <div className="px-4 py-12 text-center text-xs text-stone-400">لا توجد محادثات هنا بعد.</div>}</div>
        {hasMoreChats && <button type="button" onClick={() => void loadMoreChats()} disabled={loadingMoreChats} className="m-3 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[10px] font-bold text-stone-600 hover:bg-stone-50 disabled:opacity-50">{loadingMoreChats ? "جارٍ تحميل المزيد..." : "تحميل المزيد من المحادثات"}</button>}
        <div className="space-y-2 border-t border-stone-100 px-4 py-3 text-[10px] text-stone-400"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> متصل بالنظام</span><span className="truncate">{user?.email}</span></div><div className="flex items-center justify-between gap-2 border-t border-stone-100 pt-2"><a href="tel:+201018040600" className="font-semibold text-stone-500 hover:text-amber-800">برمجة م/ محمود سلامه</a><a href="https://wa.me/201018040600" target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 hover:text-emerald-800">واتساب</a></div></div>
      </aside>

      <section className="workspace-chat panel relative flex min-h-0 flex-col overflow-hidden bg-[#fffdf7]" onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) setIsDraggingFile(true); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingFile(false); }} onDrop={(event) => { event.preventDefault(); setIsDraggingFile(false); const file = event.dataTransfer.files?.[0]; if (file) void uploadAndSend(file); }}>
        <input ref={uploadInputRef} type="file" className="hidden" accept="image/jpeg,image/png,image/webp,audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/aac,video/mp4,video/3gpp,video/quicktime,application/pdf,text/plain,.doc,.docx,.xls,.xlsx" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadAndSend(file); }} />
        {isDraggingFile && detail && <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-2 border-dashed border-emerald-500 bg-emerald-50/90 text-lg font-extrabold text-emerald-800">أفلت الصورة أو ملصق WebP أو الصوت أو الفيديو أو الملف لإرساله</div>}
        {detail ? <>
            <button type="button" onClick={() => { ++detailRequest.current; detailLoadingIdRef.current = ""; loadingMessagesRef.current.delete(activeId); socketRef.current?.emit("conversation:leave", activeId); activeIdRef.current = ""; setActiveId(""); setDetail(null); setIncomingNotice(null); }} className="mobile-chat-back"><ArrowLeft size={16} /> رجوع للمحادثات</button>
            <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-stone-100 bg-white px-4"><div className="flex min-w-0 items-center gap-3"><Avatar name={customerDisplayName(detail.customer)} src={detail.customer?.avatarUrl} /><div className="min-w-0"><h2 className="truncate text-sm font-extrabold">{customerDisplayName(detail.customer)} {detail.isComplaint && <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600">شكوى</span>}</h2><div className="flex flex-wrap items-center gap-2 text-[10px] text-stone-400"><ChannelIcon channel={detail.channel} /> {detail.customer?.phone ? displayPhoneNumber(detail.customer.phone) : channelName(detail.channel)} · {detail.status === "OPEN" ? "محادثة مفتوحة" : detail.status}{detail.serviceTag && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800">{detail.serviceTag}</span>}</div></div></div><div className="flex items-center gap-1"><button type="button" onClick={() => void toggleFavorite()} title={favoriteIds.includes(activeId) ? "إزالة من المفضلة" : "إضافة إلى المفضلة"} aria-label={favoriteIds.includes(activeId) ? "إزالة من المفضلة" : "إضافة إلى المفضلة"} className={`grid h-9 w-9 place-items-center rounded-lg ${favoriteIds.includes(activeId) ? "text-amber-500 hover:bg-amber-50" : "text-stone-400 hover:bg-stone-100"}`}><Star size={17} fill={favoriteIds.includes(activeId) ? "currentColor" : "none"} /></button><button onClick={() => api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "PENDING" }) }).then(() => setNotice("تم تأجيل المحادثة للمتابعة لاحقًا."))} title="تأجيل" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><Clock3 size={17} /></button><button onClick={resolveConversation} title="تم الحل وإرسال استبيان الرضا" className="grid h-9 w-9 place-items-center rounded-lg text-emerald-600 hover:bg-emerald-50"><CheckCircle2 size={17} /></button><button onClick={closeConversation} title="إغلاق المحادثة" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-emerald-50 hover:text-emerald-700"><Archive size={17} /></button><button title="خيارات" className="grid h-9 w-9 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><MoreHorizontal size={18} /></button></div></div>
             {user?.role === "AGENT" && user.department === "CUSTOMER_CARE" && <div className="flex justify-end border-b border-stone-100 bg-white px-4 py-2"><button type="button" onClick={() => void openHandoffDialog()} className="flex items-center gap-1.5 rounded-lg bg-[#fff8e9] px-3 py-2 text-[10px] font-bold text-[#9b7219] hover:bg-amber-100"><Users size={14} /> تحويل لزميل متاح</button></div>}
             {detail.customer?.isBlocked && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-[10px] font-bold text-red-800"><Ban size={14} /> العميل محظور داخل النظام؛ لا يمكن إرسال ردود أو منتجات إليه.</div>}
             <div className="flex shrink-0 justify-end border-b border-stone-100 bg-white px-4 py-1.5"><button type="button" onClick={() => setShowMobileProfile(true)} className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-bold text-[#9b7219] hover:bg-amber-50"><CakeSlice size={13} /> ملف العميل وطلب سريع</button></div>
              {metaChannel && <div className={`flex shrink-0 items-center gap-2 px-4 py-2 text-[10px] font-bold ${!metaWindowOpen ? "bg-red-50 text-red-700" : expiringSoon ? "bg-[#FFC107]/20 text-[#8c650a]" : "bg-emerald-50 text-emerald-700"}`}><Clock3 size={14} />{metaWindowOpen ? `نافذة Meta مفتوحة · متبقي ${formatCountdown(windowRemaining)}` : "انتهت نافذة الـ24 ساعة للرد الحر"}{detail.isComplaint && <span className="mr-auto rounded-full bg-red-100 px-2 py-0.5 text-red-700">شكوى · خدمة العملاء</span>}</div>}
          {watching && <div className="flex h-9 shrink-0 items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 text-[11px] font-semibold text-blue-700"><Users size={14} /> المدير يراقب هذه المحادثة معك الآن</div>}
          {notice && <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-900"><span>{notice}</span><button onClick={() => setNotice("")}><span>×</span></button></div>}
            <div ref={messageListRef} onScroll={(event) => { const element = event.currentTarget; const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120; stickToBottom.current = atBottom; setShowJumpToBottom(!atBottom); }} className="soft-scroll relative flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-7">
              {detail.hasMoreMessages && <button type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages} className="mx-auto rounded-full border border-stone-200 bg-white px-4 py-2 text-[10px] font-bold text-stone-600 shadow-sm disabled:opacity-50">{loadingOlderMessages ? "جارٍ تحميل الرسائل..." : "تحميل الرسائل الأقدم"}</button>}
            <div className="mx-auto rounded-full bg-white px-3 py-1 text-[9px] text-stone-400 shadow-sm">بدأت المحادثة · {formatCairoDateTime(detail.createdAt, false)}</div>
              {(detail.messages || []).map((message: AnyRecord) => <Message key={message.id} message={message} conversationId={detail.id} onQuote={() => { setReplyingTo(message); replyInputRef.current?.focus(); }} onEdit={message.direction === "OUTBOUND" && message.authorId === user?.id && message.kind === "TEXT" && message.deliveryStatus === "SENT" ? () => beginMessageEdit(message) : undefined} onDelete={message.direction === "OUTBOUND" && message.authorId === user?.id && message.externalId && ["SENT", "DELIVERED", "READ"].includes(message.deliveryStatus) ? () => void deleteSentMessage(message) : undefined} deleting={deletingMessageId === message.id} onForward={() => setForwardMessage({ ...message, conversationId: detail.id })} editing={editingMessageId === message.id} editingText={editingText} onEditingTextChange={setEditingText} onSaveEdit={() => void saveMessageEdit(message)} onCancelEdit={() => { setEditingMessageId(""); setEditingText(""); }} savingEdit={savingEdit} onReact={(emoji) => void reactToMessage(message, emoji)} onOpenImage={setLightboxImage} />)}
             {(detail.whisperNotes || []).map((note: AnyRecord) => <div key={`whisper-${note.id}`} className="mx-auto w-full max-w-xl rounded-xl border border-[#f0d786] bg-[#fff8e1] px-4 py-3 text-xs leading-6 text-[#755916]"><div className="mb-1 flex items-center gap-1.5 font-extrabold"><CakeSlice size={14} /> توجيه سري من {note.author?.name || "المدير"}<span className="mr-auto text-[9px] font-normal text-[#aa8a36]">{ago(note.createdAt)}</span></div>{note.text}</div>)}
              {(detail.internalNotes || []).map((note: AnyRecord) => <div key={`note-${note.id}`} className="mx-auto w-full max-w-xl rounded-xl border border-blue-100 bg-blue-50/80 px-4 py-3 text-xs leading-6 text-blue-950"><div className="mb-1 flex items-center gap-1.5 font-extrabold">ملاحظة داخلية · {note.author?.name || "الفريق"}<span className="mr-auto text-[9px] font-normal text-blue-500">{ago(note.createdAt)}</span></div>{note.text}</div>)}
             <div className="mt-auto" /><div ref={messageEndRef} />
             {showJumpToBottom && <button type="button" onClick={() => { stickToBottom.current = true; messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); setShowJumpToBottom(false); }} className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white shadow-lg"><ArrowDown size={13} /> الرسائل الجديدة</button>}
          </div>
          <div className="relative shrink-0 border-t border-stone-100 bg-white p-3 sm:p-4">
             {!metaWindowOpen && detail.channel === "MESSENGER" && <div className="mb-3 rounded-xl border border-red-100 bg-red-50 p-3 text-[10px] leading-5 text-red-700">انتهت نافذة رد Messenger. يجب أن يرسل العميل رسالة جديدة قبل استئناف الردود الحرة.</div>}
              {recording && <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2"><span className="flex items-center gap-2 text-xs font-bold text-red-700"><span className="h-2 w-2 animate-pulse rounded-full bg-red-600"/>تسجيل جارٍ · {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")}</span><div className="flex gap-2"><button type="button" onClick={cancelRecording} className="rounded-lg bg-white px-3 py-2 text-[10px] font-bold text-stone-600">إلغاء</button><button type="button" onClick={sendRecording} className="rounded-lg bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white">إرسال التسجيل</button></div></div>}
              {replyingTo && <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[10px] text-amber-900"><ReplyIcon size={14} /><span className="min-w-0 flex-1 truncate">رد على: {replyingTo.text || (replyingTo.kind === "IMAGE" ? "صورة" : "رسالة مرفقة")}</span><button type="button" onClick={() => setReplyingTo(null)} className="rounded-md px-2 py-1 font-bold hover:bg-amber-100">إلغاء</button></div>}
              {detail.channel !== "MESSENGER" && <div className="mb-2 flex justify-end"><button type="button" disabled={!metaWindowOpen || sendingPoll} onClick={() => setShowPollComposer(true)} className="flex items-center gap-1 rounded-lg bg-sky-50 px-2.5 py-1.5 text-[10px] font-bold text-sky-700 disabled:opacity-40"><ListChecks size={14} /> إنشاء استطلاع</button></div>}
            {showCanned && <div className="soft-scroll absolute bottom-[calc(100%-4px)] right-4 z-10 max-h-60 w-[min(340px,calc(100%-32px))] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-xl">{filteredCanned.map((reply) => <button key={reply.id} onClick={() => { setText(reply.content); setShowCanned(false); }} className="flex w-full flex-col rounded-xl px-3 py-2 text-right hover:bg-[#fff8e9]"><b className="text-xs text-[#b71c1c]">{reply.shortcut} <span className="font-medium text-stone-500">· {reply.title}</span></b><span className="mt-1 line-clamp-2 text-[10px] leading-5 text-stone-400">{reply.content}</span></button>)}{!filteredCanned.length && <p className="px-3 py-4 text-xs text-stone-400">لا يوجد رد مطابق</p>}</div>}
             <form onSubmit={sendReply}><div className="rounded-2xl border border-stone-200 bg-white focus-within:border-[#e4b8a8] focus-within:shadow-[0_0_0_3px_rgba(211,47,47,.05)]"><textarea ref={replyInputRef} rows={2} value={text} disabled={!messagingEnabled} onChange={(e) => { setText(e.target.value); setShowCanned(e.target.value.startsWith("/")); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !showCanned) { e.preventDefault(); void submitReply(); } }} placeholder={detail.customer?.isBlocked ? "العميل محظور داخل النظام" : metaWindowOpen ? "اكتب ردك هنا... اكتب / للردود الجاهزة" : "الرد الحر مقفل حتى يرد العميل"} className="max-h-32 min-h-[62px] w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-stone-300 disabled:cursor-not-allowed disabled:bg-stone-50" />
                <div className="flex flex-wrap items-center justify-between gap-1 border-t border-stone-100 px-2 py-2"><div className="flex items-center gap-1"><button type="button" disabled={!metaWindowOpen} title="ردود جاهزة" onClick={() => { setText(text.startsWith("/") ? text : "/"); setShowCanned(!showCanned); }} className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-[#bd8e21] hover:bg-amber-50 disabled:opacity-40">/ رد جاهز</button><button type="button" disabled={!metaWindowOpen} onClick={() => setShowProducts(true)} className="flex items-center gap-1 rounded-lg bg-[#fff8e9] px-2 py-1.5 text-[10px] font-bold text-[#9b7219] disabled:opacity-40"><CakeSlice size={14} /> إرسال منتج</button><button type="button" title="إرفاق ملف" disabled={!metaWindowOpen || sending} onClick={() => uploadInputRef.current?.click()} className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 hover:bg-stone-100 disabled:opacity-40"><Paperclip size={16} /></button><button type="button" title={recording ? "إيقاف التسجيل وإرساله" : "تسجيل رسالة صوتية"} disabled={!metaWindowOpen || sending} onClick={() => void toggleRecording()} className={`grid h-8 w-8 place-items-center rounded-lg ${recording ? "bg-red-50 text-red-600" : "text-stone-400 hover:bg-stone-100"} disabled:opacity-40`}>{recording ? <MicOff size={16} /> : <Mic size={16} />}</button><button type="button" title={soundEnabled ? "إيقاف صوت الرسائل الجديدة" : "تشغيل صوت الرسائل الجديدة"} onClick={() => { const next = !soundEnabled; setSoundEnabled(next); setNotificationSoundEnabled(next); }} className={`grid h-8 w-8 place-items-center rounded-lg ${soundEnabled ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100"}`}>{soundEnabled ? <Bell size={16} /> : <BellOff size={16} />}</button><button type="button" title="إرسال موقعي الحالي" aria-label="إرسال موقعي الحالي" disabled={!metaWindowOpen || sending} onClick={shareLocation} className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 hover:bg-stone-100 disabled:opacity-40"><MapPin size={16} /></button></div><button disabled={!text.trim() || !metaWindowOpen || sending} className="flex h-9 items-center gap-2 rounded-xl bg-[#d32f2f] px-4 text-xs font-bold text-white shadow-sm shadow-red-200 transition hover:bg-[#b71c1c] disabled:cursor-not-allowed disabled:opacity-40"><span className="hidden sm:inline">{sending ? "جارٍ الإرسال" : "إرسال"}</span><Send size={15} /></button></div>
              </div></form><p className="mt-2 text-center text-[9px] text-stone-400">Enter للإرسال · Shift + Enter لسطر جديد · رسائل العملاء تمر عبر القناة الأصلية</p>
          </div>
        </> : activeId ? <div className="grid flex-1 place-items-center text-xs text-stone-400">جارٍ تحميل المحادثة...</div> : <div className="grid flex-1 place-items-center text-center"><div><div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-[#fff2dd] text-[#c38f22]"><MessageCircle size={28} /></div><h2 className="mt-4 font-extrabold">اختر محادثة للبدء</h2><p className="mt-1 text-xs text-stone-400">ستظهر لك الرسائل وتفاصيل العميل هنا.</p></div></div>}
      </section>

      <aside className={`workspace-profile panel soft-scroll flex min-h-0 flex-col gap-4 overflow-y-auto p-4 ${showMobileProfile ? "workspace-profile-open" : ""}`}>
        {detail ? <>
           <button type="button" onClick={() => setShowMobileProfile(false)} className="mobile-chat-back"><X size={16} /> إغلاق الملف</button>
           <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-extrabold">ملف العميل</h2><div className="flex items-center gap-1"><button type="button" onClick={() => void togglePin()} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold ${pinnedIds.includes(activeId) ? "bg-blue-50 text-blue-700" : "text-stone-400 hover:bg-stone-100"}`} aria-label={pinnedIds.includes(activeId) ? "إلغاء تثبيت المحادثة" : "تثبيت المحادثة"}><Pin size={14} />{pinnedIds.includes(activeId) ? "مثبتة" : "تثبيت"}</button><button type="button" onClick={() => void toggleCustomerFavorite()} disabled={savingCustomerFavorite} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold disabled:opacity-50 ${favoriteCustomerIds.includes(detail.customer?.id) ? "bg-amber-50 text-amber-700" : "text-stone-400 hover:bg-stone-100"}`} aria-label={favoriteCustomerIds.includes(detail.customer?.id) ? "إزالة العميل من المفضلة" : "حفظ العميل في المفضلة"}><Star size={14} fill={favoriteCustomerIds.includes(detail.customer?.id) ? "currentColor" : "none"} />{favoriteCustomerIds.includes(detail.customer?.id) ? "مفضل" : "حفظ العميل"}</button></div></div>
           <div className="rounded-2xl bg-[#fff8e9] p-4 text-center"><AvatarLarge name={customerDisplayName(detail.customer)} src={detail.customer?.avatarUrl} /><h3 className="mt-3 font-extrabold">{customerDisplayName(detail.customer)}</h3><p className="mt-1 text-[10px] text-stone-400">عميل منذ {formatCairoDateTime(detail.customer?.createdAt || detail.createdAt, false)}</p><div className="mt-3 flex justify-center gap-2"><a href={detail.customer?.phone ? `tel:${String(detail.customer.phone).replace(/[^0-9+*#;]/g, "")}` : undefined} aria-label="الاتصال بالعميل" title="الاتصال بالعميل" className={`grid h-9 w-9 place-items-center rounded-xl bg-white ${detail.customer?.phone ? "text-stone-500 hover:bg-emerald-50 hover:text-emerald-700" : "pointer-events-none text-stone-300"}`}><Phone size={15} /></a><button type="button" onClick={() => replyInputRef.current?.focus()} aria-label="إرسال رسالة للعميل" title="الانتقال إلى مربع الرد" className="grid h-9 w-9 place-items-center rounded-xl bg-white text-stone-500 hover:bg-amber-50 hover:text-amber-700"><MessageCircle size={15} /></button></div></div>
            {detail.channel === "WHATSAPP" && <button type="button" disabled={detail.customer?.isBlocked || !callTarget} onClick={() => setShowWhatsAppCall(true)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-3 py-2.5 text-xs font-extrabold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"><PhoneCall size={16} />مكالمة WhatsApp داخل النظام</button>}
            <div className="grid grid-cols-2 gap-2"><button type="button" disabled={savingCustomerFlags} onClick={() => void toggleCustomerFlag("isVip")} className={`rounded-xl px-3 py-2 text-[10px] font-bold disabled:opacity-50 ${detail.customer?.isVip ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600 hover:bg-amber-50"}`}>{detail.customer?.isVip ? "VIP · إزالة التمييز" : "تمييز العميل VIP"}</button><button type="button" disabled={savingCustomerFlags} onClick={() => void toggleCustomerFlag("isBlocked")} className={`flex items-center justify-center gap-1 rounded-xl px-3 py-2 text-[10px] font-bold disabled:opacity-50 ${detail.customer?.isBlocked ? "bg-red-100 text-red-800" : "bg-stone-100 text-stone-600 hover:bg-red-50 hover:text-red-700"}`}><Ban size={13} />{detail.customer?.isBlocked ? "إلغاء الحظر" : "حظر داخل النظام"}</button></div>
             <div className="grid grid-cols-2 gap-2"><Info label="الهاتف" value={displayPhoneNumber(detail.customer?.phone)} /><Info label="القناة" value={channelName(detail.channel)} /></div>
            <form onSubmit={saveCustomerProfile} className="space-y-3 rounded-2xl border border-stone-100 bg-white p-3">
              <label className="block text-[10px] font-bold text-stone-500">اسم العميل<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">رقم الهاتف<input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} maxLength={32} dir="ltr" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">البريد الإلكتروني<input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} maxLength={254} dir="ltr" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">ملاحظات سريعة<textarea value={customerNotes} onChange={(event) => setCustomerNotes(event.target.value)} maxLength={4000} rows={3} placeholder="مثال: يفضل التواصل مساءً" className="mt-1 w-full resize-y rounded-lg border border-stone-200 px-2 py-2 text-xs font-normal leading-5 text-stone-700 outline-none focus:border-amber-300" /></label>
              <button type="submit" disabled={savingCustomer} className="h-9 w-full rounded-lg bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-60">{savingCustomer ? "جارٍ الحفظ..." : "حفظ بيانات العميل"}</button>
            </form>
            <form onSubmit={addInternalNote} className="space-y-2 rounded-2xl border border-blue-100 bg-blue-50/60 p-3"><label className="block text-[10px] font-bold text-blue-900">ملاحظة داخلية للفريق<textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} maxLength={4000} rows={2} placeholder="تظهر لموظفي الفريق فقط، ولا ترسل للعميل" className="mt-1 w-full resize-y rounded-lg border border-blue-100 bg-white px-2 py-2 text-xs font-normal leading-5 text-stone-700 outline-none focus:border-blue-300" /></label><button disabled={!internalNote.trim()} className="h-9 w-full rounded-lg bg-blue-800 text-xs font-bold text-white disabled:opacity-40">إضافة ملاحظة داخلية</button></form>
           <div className="flex items-center justify-between rounded-xl border border-[#f0e7d6] bg-[#fffdf7] px-3 py-2"><div><b className="text-[11px]">أمر تحضير</b><p className="text-[9px] text-stone-400">احفظ الطلب ثم اطبعه أو صدّره PDF</p></div><button type="button" onClick={printOrder} className="flex items-center gap-1 rounded-lg bg-[#d32f2f] px-2.5 py-2 text-[9px] font-bold text-white"><Printer size={13} /> طباعة</button></div>
            <label className="block text-[10px] font-bold text-stone-500">السعر بالجنيه المصري<input type="number" min="0" step="0.01" value={order.price} onChange={(e) => setOrder({ ...order, price: e.target.value })} placeholder="اختياري" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label>
          <div className="border-t border-stone-100 pt-3"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-extrabold">طلب حلويات جديد</h3><span className="rounded-full bg-amber-50 px-2 py-1 text-[9px] font-bold text-amber-700">مسودة</span></div><form onSubmit={saveOrder} className="space-y-2.5"><label className="block text-[10px] font-bold text-stone-500">الصنف<input value={order.product} onChange={(e) => setOrder({ ...order, product: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label><div className="grid grid-cols-2 gap-2"><label className="text-[10px] font-bold text-stone-500">الحجم<input value={order.size} onChange={(e) => setOrder({ ...order, size: e.target.value })} placeholder="مثال: 2 كجم" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="text-[10px] font-bold text-stone-500">الحشوة<input value={order.filling} onChange={(e) => setOrder({ ...order, filling: e.target.value })} placeholder="شوكولاتة" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label></div><label className="block text-[10px] font-bold text-stone-500">العبارة على التورتة<input value={order.cakeMessage} onChange={(e) => setOrder({ ...order, cakeMessage: e.target.value })} placeholder="كل عام وأنت بخير" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">موعد التسليم<input type="datetime-local" value={order.deliveryAt} onChange={(e) => setOrder({ ...order, deliveryAt: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-[10px] font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">عنوان التوصيل<input value={order.deliveryAddress} onChange={(e) => setOrder({ ...order, deliveryAddress: e.target.value })} placeholder="المدينة، الشارع..." className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#d32f2f] text-xs font-bold text-white hover:bg-[#b71c1c]"><Check size={14} /> حفظ الطلب</button></form></div>
          {!!detail.customer?.orders?.length && <div className="border-t border-stone-100 pt-3"><h3 className="mb-2 text-xs font-extrabold">آخر الطلبات</h3>{detail.customer.orders.slice(0, 3).map((item: AnyRecord) => <div key={item.id} className="mb-2 rounded-xl bg-stone-50 px-3 py-2 text-[10px]"><div className="font-bold">{item.product || "طلب حلويات"}</div><div className="mt-1 flex items-center justify-between gap-2 text-stone-400"><span>{orderStatus(item.status)} · {ago(item.createdAt)}</span>{item.status !== "DELIVERED" && item.status !== "COMPLETED" && item.status !== "CANCELLED" && <select aria-label="تحديث حالة الطلب" value={item.status} onChange={(e) => updateOrderStatus(item.id, e.target.value)} className="max-w-32 rounded-lg border border-stone-200 bg-white px-2 py-1 font-bold text-[#b71c1c]"><option value="DRAFT">مسودة</option><option value="CONFIRMED">مؤكد</option><option value="PREPARING">قيد التجهيز</option><option value="OUT_FOR_DELIVERY">خرج للتوصيل</option><option value="DELIVERED">تم التسليم</option><option value="CANCELLED">إلغاء الطلب</option></select>}</div></div>)}</div>}
          <div className="mt-auto flex items-center gap-2 rounded-xl border border-dashed border-stone-200 p-3 text-[10px] leading-5 text-stone-400"><Clock3 size={16} className="shrink-0" /> بيانات العميل وطلباته محفوظة بشكل آمن ضمن سجل المحادثة.</div>
        </> : <div className="grid flex-1 place-items-center text-center text-xs text-stone-400"><div><UserRound size={25} className="mx-auto text-stone-300" /><p className="mt-2">ملف العميل سيظهر هنا</p></div></div>}
      </aside>
    </section>
      {incomingCall && <IncomingWhatsAppCallModal call={incomingCall} onReject={rejectIncomingWhatsAppCall} onOpenConversation={openIncomingCallConversation} onDismiss={() => setIncomingCall(null)} />}
      {showWhatsAppCall && detail && <WhatsAppCallModal conversationId={detail.id} customerName={customerDisplayName(detail.customer)} phone={callTarget} socket={socket} onClose={() => setShowWhatsAppCall(false)} />}
     {lightboxImage && <div role="dialog" aria-modal="true" aria-label="معاينة الصورة" onClick={() => setLightboxImage("")} className="fixed inset-0 z-[70] grid place-items-center bg-black/90 p-4"><button type="button" aria-label="إغلاق معاينة الصورة" onClick={() => setLightboxImage("")} className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/15 text-2xl text-white hover:bg-white/25">×</button><img src={lightboxImage} alt="معاينة مكبرة" onClick={(event) => event.stopPropagation()} className="max-h-[88vh] max-w-[94vw] rounded-lg object-contain shadow-2xl" /></div>}
     {forwardMessage && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => { setForwardMessage(null); setForwardQuery(""); }}><section role="dialog" aria-modal="true" aria-labelledby="forward-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="forward-title" className="text-base font-extrabold">تحويل الرسالة</h2><p className="mt-1 text-xs leading-5 text-stone-500">ستُرسل نسخة من الرسالة إلى محادثة أخرى.</p></div><button type="button" onClick={() => { setForwardMessage(null); setForwardQuery(""); }} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><input autoFocus value={forwardQuery} onChange={(event) => setForwardQuery(event.target.value)} placeholder="ابحث عن محادثة" className="mb-3 h-10 w-full rounded-xl border border-stone-200 px-3 text-xs outline-none focus:border-amber-400" /><div className="max-h-[55vh] space-y-2 overflow-y-auto">{conversations.filter((item) => item.id !== forwardMessage.conversationId && customerDisplayName(item.customer).toLocaleLowerCase().includes(forwardQuery.trim().toLocaleLowerCase())).map((target) => <button key={target.id} type="button" onClick={() => void forwardMessageTo(target)} className="flex w-full items-center gap-3 rounded-xl border border-stone-100 bg-white p-3 text-right hover:border-amber-200 hover:bg-amber-50"><Avatar name={customerDisplayName(target.customer)} src={target.customer?.avatarUrl} /><span className="min-w-0 flex-1"><b className="block truncate text-xs">{customerDisplayName(target.customer)}</b><span className="mt-1 flex items-center gap-1.5 text-[10px] text-stone-400"><ChannelIcon channel={target.channel} />{channelName(target.channel)}</span></span><Forward size={15} className="text-stone-400" /></button>)}{!conversations.some((item) => item.id !== forwardMessage.conversationId && customerDisplayName(item.customer).toLocaleLowerCase().includes(forwardQuery.trim().toLocaleLowerCase())) && <p className="rounded-xl bg-stone-50 p-5 text-center text-xs text-stone-500">لا توجد محادثات مطابقة ضمن المحادثات المحمّلة.</p>}</div></section></div>}
     {showHandoff && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowHandoff(false)}><section role="dialog" aria-modal="true" aria-labelledby="handoff-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="handoff-title" className="text-base font-extrabold">تحويل المحادثة لزميل</h2><p className="mt-1 text-xs leading-5 text-stone-500">اختر موظفًا متاحًا من خدمة العملاء ليتابع مع العميل.</p></div><button type="button" onClick={() => setShowHandoff(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><div className="max-h-[55vh] space-y-2 overflow-y-auto">{handoffColleagues.map((colleague) => <button key={colleague.id} type="button" disabled={Boolean(handoffBusyId)} onClick={() => void handoffToColleague(colleague.id, colleague.name)} className="flex w-full items-center gap-3 rounded-xl border border-stone-100 bg-white p-3 text-right hover:border-amber-200 hover:bg-amber-50 disabled:opacity-60"><Avatar name={colleague.name} /><span className="min-w-0 flex-1"><b className="block truncate text-sm">{colleague.name}</b><span className="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" /> متاح الآن</span></span><span className="rounded-lg bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white">{handoffBusyId === colleague.id ? "جارٍ التحويل..." : "تحويل"}</span></button>)}{!handoffColleagues.length && <div className="rounded-xl bg-stone-50 p-5 text-center text-xs leading-6 text-stone-500">لا يوجد زميل متاح الآن في خدمة العملاء. جرّب لاحقًا أو أبقِ المحادثة لديك.</div>}</div></section></div>}
    {showProducts && <div className="fixed inset-0 z-40 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => { setShowProducts(false); setSelectedProductIds([]); }}><section className="panel max-h-[90vh] w-full max-w-4xl overflow-y-auto p-4 sm:p-6" onClick={(event) => event.stopPropagation()}>
      <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold">كتالوج حلواني بندق</h2><p className="text-xs text-stone-400">حدد منتجًا واحدًا أو أكثر لإرسال السعر والصورة معًا</p></div><button type="button" onClick={() => { setShowProducts(false); setSelectedProductIds([]); }} className="rounded-lg px-3 py-1 text-xl text-stone-400">×</button></div>
       <div className="soft-scroll mb-4 flex gap-2 overflow-x-auto pb-1">{[{ id: "ALL", label: "الكل" }, { id: "EASTERN", label: "شرقي" }, { id: "WESTERN", label: "غربي" }, { id: "CAKES", label: "تورتات" }, { id: "BAKERY", label: "مخبوزات" }, { id: "KAHK", label: "كحك وبسكويت" }, { id: "CHOCOLATE", label: "شوكولاتة" }, { id: "MOULID", label: "حلاوة المولد" }, { id: "OCCASIONS", label: "مناسبات" }, { id: "MIX_BONDOQ", label: "ميكس بندق" }].filter((item) => item.id === "ALL" || products.some((product) => product.category === item.id)).map((item) => <button type="button" key={item.id} onClick={() => setProductFilter(item.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${productFilter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500"}`}>{item.label}</button>)}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleProducts.map((product) => {
        const isSelected = selectedProductIds.includes(product.id);
        return <article key={product.id} className={`overflow-hidden rounded-2xl border bg-white ${isSelected ? "border-[#d32f2f] ring-2 ring-red-100" : "border-stone-100"}`}>
          {product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-36 w-full object-cover" /> : <div className="grid h-36 place-items-center bg-[#fff6e5] text-[#bd8e21]"><CakeSlice size={38} /></div>}
          <div className="p-3"><div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-extrabold">{product.name}</h3><p className="mt-1 text-[10px] text-stone-400">{categoryLabel(product.category)}</p></div><b className="shrink-0 text-xs text-[#a57a1c]">{Number(product.price).toFixed(2)} ج.م</b></div>{product.description && <p className="mt-2 line-clamp-2 text-[10px] leading-5 text-stone-500">{product.description}</p>}
            <button type="button" disabled={!product.imageUrl} aria-pressed={isSelected} onClick={() => toggleProductSelection(product.id)} className={`mt-3 w-full rounded-xl px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-stone-300 ${isSelected ? "bg-stone-700" : "bg-[#d32f2f]"}`}>{!product.imageUrl ? "أضف صورة المنتج أولًا" : isSelected ? "إزالة من التحديد" : "تحديد للإرسال"}</button>
          </div>
        </article>;
      })}</div>
      {!visibleProducts.length && <div className="py-12 text-center text-sm text-stone-400">لا توجد منتجات في هذا القسم.</div>}
      <footer className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 bg-white py-3"><span className="text-xs font-semibold text-stone-500">{selectedProductIds.length ? `تم تحديد ${selectedProductIds.length} من 12 منتجًا` : "حدد المنتجات المطلوبة أولًا"}</span><button type="button" disabled={!selectedProductIds.length || sendingProducts} onClick={() => void sendSelectedProducts()} className="rounded-xl bg-[#d32f2f] px-5 py-3 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:bg-stone-300">{sendingProducts ? "جارٍ الإرسال..." : `إرسال ${selectedProductIds.length || "المنتجات المحددة"} للعميل`}</button></footer>
    </section></div>}
     {savedOrder && detail && <section className="print-ticket" dir="rtl"><h1>حلواني بندق · أمر تحضير</h1><div className="ticket-rule" /><p><b>رقم الطلب:</b> {savedOrder.id}</p><p><b>العميل:</b> {customerDisplayName(detail.customer)}</p><p><b>الهاتف:</b> {detail.customer?.phone || "غير متوفر"}</p><div className="ticket-rule" /><p><b>الصنف:</b> {savedOrder.product || "تورتة"}</p><p><b>الحجم:</b> {savedOrder.size || "—"}　 <b>الحشوة:</b> {savedOrder.filling || "—"}</p><p><b>السعر:</b> {savedOrder.price ? `${Number(savedOrder.price).toFixed(2)} جنيه مصري` : "غير محدد"}</p><p><b>العبارة:</b> {savedOrder.cakeMessage || "—"}</p><p><b>التسليم:</b> {formatCairoDateTime(savedOrder.deliveryAt)}</p><p><b>العنوان:</b> {savedOrder.deliveryAddress || "—"}</p><p><b>ملاحظات:</b> {savedOrder.notes || "—"}</p><div className="ticket-rule" /><p className="ticket-footer">يُسلّم إلى قسم الإنتاج · {formatCairoDateTime(new Date())}</p></section>}
     {showPollComposer && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowPollComposer(false)}><section role="dialog" aria-modal="true" aria-labelledby="poll-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="poll-title" className="text-base font-extrabold">إنشاء استطلاع</h2><p className="mt-1 text-xs leading-5 text-stone-500">متاح في Telegram وWhatsApp عبر Baileys. لا يمكن تعديل الاستطلاع بعد إرساله.</p></div><button type="button" onClick={() => setShowPollComposer(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><form onSubmit={(event) => void createPoll(event)} className="space-y-3"><label className="block text-xs font-bold text-stone-600">سؤال الاستطلاع<input required maxLength={300} value={pollQuestion} onChange={(event) => setPollQuestion(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal outline-none focus:border-sky-400" /></label><label className="block text-xs font-bold text-stone-600">الخيارات <span className="font-normal text-stone-400">(خيار واحد في كل سطر)</span><textarea required rows={6} maxLength={1200} value={pollOptionsText} onChange={(event) => setPollOptionsText(event.target.value)} placeholder={'الخيار الأول\nالخيار الثاني'} className="mt-1 w-full resize-y rounded-xl border border-stone-200 px-3 py-2 text-sm font-normal leading-6 outline-none focus:border-sky-400" /></label><p className="text-[10px] leading-5 text-stone-400">أضف من خيارين إلى عشرة. التصويت والنتائج تتم في القناة الأصلية.</p><div className="flex justify-end gap-2"><button type="button" onClick={() => setShowPollComposer(false)} className="rounded-xl bg-stone-100 px-4 py-2.5 text-xs font-bold text-stone-600">إلغاء</button><button type="submit" disabled={sendingPoll || !metaWindowOpen} className="rounded-xl bg-sky-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{sendingPoll ? "جارٍ الإرسال..." : "إرسال الاستطلاع"}</button></div></form></section></div>}
     {showAccount && user && <AccountSettingsModal user={user} onClose={() => setShowAccount(false)} onSaved={setUser} />}
   </main>;
}

function Avatar({ name, src }: { name: string; src?: string }) { return <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffe3cd] to-[#ffedb4] font-bold text-[#965a36]">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function AvatarLarge({ name, src }: { name: string; src?: string }) { return <span className="mx-auto grid h-16 w-16 place-items-center overflow-hidden rounded-[22px] bg-white text-2xl font-extrabold text-[#b67739] shadow-sm">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl bg-stone-50 p-2.5"><p className="text-[9px] text-stone-400">{label}</p><p className="mt-1 truncate text-[10px] font-bold text-stone-700" dir="auto">{value}</p></div>; }
function ChannelIcon({ channel }: { channel: string }) { const config: Record<string, { label: string; className: string }> = { WHATSAPP: { label: "W", className: "bg-emerald-100 text-emerald-700" }, MESSENGER: { label: "M", className: "bg-blue-100 text-blue-700" }, TELEGRAM: { label: "T", className: "bg-sky-100 text-sky-700" } }; const item = config[channel] || config.WHATSAPP; return <span title={channelName(channel)} className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md text-[9px] font-black ${item.className}`}>{item.label}</span>; }
 function Message({ message, conversationId, onQuote, onEdit, onDelete, deleting = false, onForward, editing = false, editingText = "", onEditingTextChange, onSaveEdit, onCancelEdit, savingEdit = false, onReact, onOpenImage }: { message: AnyRecord; conversationId: string; onQuote?: () => void; onEdit?: () => void; onDelete?: () => void; deleting?: boolean; onForward?: () => void; editing?: boolean; editingText?: string; onEditingTextChange?: (value: string) => void; onSaveEdit?: () => void; onCancelEdit?: () => void; savingEdit?: boolean; onReact?: (emoji: string) => void; onOpenImage?: (url: string) => void }) {
  const outgoing = message.direction === "OUTBOUND";
  const hasMedia = ["IMAGE", "AUDIO", "VIDEO", "FILE", "STICKER"].includes(message.kind);
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const deliveryLabel = message.deliveryStatus === "PENDING" ? "جارٍ الإرسال" : message.deliveryStatus === "QUEUED" ? "في قائمة الإرسال" : message.deliveryStatus === "FAILED" ? "تعذر الإرسال" : message.deliveryStatus === "READ" ? "مقروء" : message.deliveryStatus === "DELIVERED" ? "تم التسليم" : message.author?.name || "تم الإرسال";
  return <div className={`flex ${outgoing ? "justify-start" : "justify-end"}`}><div className={`max-w-[82%] rounded-2xl px-4 py-3 shadow-sm ${outgoing ? "rounded-tr-sm bg-white" : "rounded-tl-sm bg-[#fff0d1]"}`}>
    {message.quotedMessage && <div className="mb-2 rounded-lg border-r-2 border-[#d32f2f] bg-stone-50/80 px-2.5 py-1.5 text-[10px] text-stone-500"><b>{message.quotedMessage.author?.name || "رسالة مقتبسة"}</b><p className="mt-0.5 line-clamp-2">{message.quotedMessage.text || (message.quotedMessage.kind === "IMAGE" ? "صورة" : "مرفق")}</p></div>}
    {hasMedia && (message.localPreviewUrl ? ["IMAGE", "STICKER"].includes(message.kind) ? <button type="button" onClick={() => onOpenImage?.(message.localPreviewUrl)} className="mb-2 block"><img src={message.localPreviewUrl} alt={message.kind === "STICKER" ? "ملصق قيد الإرسال" : "صورة قيد الإرسال"} className="max-h-56 rounded-xl object-contain" /></button> : message.kind === "AUDIO" ? <audio controls src={message.localPreviewUrl} className="mb-2 max-w-full" /> : message.kind === "VIDEO" ? <video controls src={message.localPreviewUrl} className="mb-2 max-h-56 max-w-full rounded-xl" /> : <span className="mb-2 block text-xs">ملف مرفق قيد الإرسال</span> : message.mediaAssetId ? <ProtectedMedia conversationId={conversationId} message={message} onOpenImage={onOpenImage} /> : message.kind === "IMAGE" && outgoing && message.mediaUrl ? <button type="button" onClick={() => onOpenImage?.(message.mediaUrl)} className="mb-2 block"><img src={message.mediaUrl} alt="منتج حلواني بندق" className="max-h-56 rounded-xl object-cover" /></button> : <ProtectedMedia conversationId={conversationId} message={message} onOpenImage={onOpenImage} />)}
    {message.kind === "AUDIO" && message.transcription && <p className="mb-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-6 text-stone-700">تفريغ صوتي: {message.transcription}</p>}
    {editing ? <div className="my-2 min-w-[230px]"><textarea autoFocus rows={3} maxLength={4000} value={editingText} onChange={(event) => onEditingTextChange?.(event.target.value)} className="w-full resize-y rounded-xl border border-amber-200 bg-white p-2 text-sm leading-6 outline-none focus:border-amber-400" /><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={onCancelEdit} className="rounded-lg bg-stone-100 px-3 py-1.5 text-[10px] font-bold text-stone-600">إلغاء</button><button type="button" disabled={savingEdit || !editingText.trim()} onClick={onSaveEdit} className="rounded-lg bg-[#d32f2f] px-3 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">{savingEdit ? "جارٍ الحفظ..." : "حفظ التعديل"}</button></div></div> : message.kind === "POLL" ? <div className="min-w-[220px] rounded-xl border border-sky-100 bg-sky-50/60 p-3"><div className="mb-1 text-[9px] font-extrabold uppercase tracking-wide text-sky-700">استطلاع</div><p className="whitespace-pre-wrap text-sm font-bold leading-6">{message.text}</p><div className="mt-2 space-y-1.5">{(Array.isArray(metadata.pollOptions) ? metadata.pollOptions : []).map((option: string, index: number) => <div key={`${option}-${index}`} className="rounded-lg border border-sky-100 bg-white px-2.5 py-1.5 text-xs">{option}</div>)}</div><p className="mt-2 text-[9px] text-stone-400">التصويت والنتائج متاحان على المنصة الأصلية.</p></div> : message.kind === "LOCATION" ? <a className="flex items-center gap-2 text-sm text-blue-700 underline" href={`https://maps.google.com/?q=${message.latitude},${message.longitude}`} target="_blank"><MapPin size={16} /> فتح موقع العميل</a> : message.text && <p className="whitespace-pre-wrap text-sm leading-7">{message.text}</p>}
      <div className="mt-1.5 flex items-center gap-1 text-[9px] text-stone-400">{metadata.forwardedFrom && <span>محوّلة · </span>}{outgoing && `${deliveryLabel} · `}{formatCairoTime(message.createdAt)}{metadata.editedAt && <span className="text-stone-400"> · معدلة</span>}{outgoing && ["SENT", "DELIVERED", "READ"].includes(message.deliveryStatus) && (message.deliveryStatus === "SENT" ? <Check size={11} className="text-stone-400" /> : <CheckCheck size={11} className={message.deliveryStatus === "READ" ? "text-sky-600" : "text-stone-400"} />)}</div>
      {!!message.reactions?.length && <div className="mt-2 flex flex-wrap gap-1">{message.reactions.map((reaction: AnyRecord) => <button key={reaction.id} type="button" title={reaction.user?.name || "تفاعل"} onClick={() => onReact?.(reaction.emoji)} className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[10px]">{reaction.emoji}</button>)}</div>}
        <div className="mt-2 flex items-center justify-end gap-1 border-t border-stone-100/70 pt-1.5"><button type="button" onClick={onQuote} title="الرد على هذه الرسالة" aria-label="الرد على هذه الرسالة" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-white hover:text-stone-700"><ReplyIcon size={13} /></button>{onEdit && <button type="button" onClick={onEdit} title="تعديل الرسالة" aria-label="تعديل الرسالة" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-white hover:text-stone-700"><Pencil size={13} /></button>}{onDelete && <button type="button" disabled={deleting} onClick={onDelete} title="حذف الرسالة" aria-label="حذف الرسالة" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"><Trash2 size={13} /></button>}{onForward && message.kind !== "SYSTEM" && <button type="button" onClick={onForward} title="تحويل الرسالة إلى محادثة أخرى" aria-label="تحويل الرسالة إلى محادثة أخرى" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-white hover:text-stone-700"><Forward size={13} /></button>}{["👍", "❤️", "😂"].map((emoji) => <button type="button" key={emoji} onClick={() => onReact?.(emoji)} title={`تفاعل ${emoji}`} className="grid h-7 min-w-7 place-items-center rounded-lg text-sm hover:bg-white">{emoji}</button>)}</div>
  </div></div>;
}
function department(value?: string) { return ({ CAKES: "مبيعات التورتات", DELIVERY: "طلبات التوصيل", CUSTOMER_CARE: "خدمة العملاء", QUALITY: "قسم الجودة", HEADQUARTERS: "المقر الرئيسي · HQ", WORK_FROM_HOME: "العمل من المنزل · WFH", BRANCH: "موظف فرع", ADMINISTRATION: "الإدارة" } as Record<string, string>)[value || ""] || "فريق بندق"; }
function channelName(value: string) { return ({ WHATSAPP: "واتساب", MESSENGER: "ماسنجر", TELEGRAM: "تليجرام" } as Record<string, string>)[value] || value; }
function ago(value?: string) { if (!value) return "الآن"; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? "الآن" : minutes < 60 ? `منذ ${minutes} د` : `منذ ${Math.floor(minutes / 60)} س`; }
function orderStatus(value: string) { return ({ DRAFT: "مسودة", CONFIRMED: "مؤكد", PREPARING: "قيد التجهيز", OUT_FOR_DELIVERY: "خرج للتوصيل", DELIVERED: "تم التسليم", CANCELLED: "ملغي", COMPLETED: "مكتمل" } as Record<string, string>)[value] || value; }
function categoryLabel(value: string) { return productCategoryLabel[value] || value; }
function formatCountdown(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`; }
