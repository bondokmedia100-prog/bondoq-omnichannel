"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Archive, ArrowDown, ArrowLeft, ArrowRight, Ban, Bell, BellOff, BookUser, CalendarDays, Camera, CakeSlice, Check, CheckCheck, CheckCircle2, Circle, Clock3, Copy, Eraser, FileText, Forward, Image as ImageIcon, ListChecks, LockKeyhole, MapPin, MessageCircle, Mic, MicOff, MoreHorizontal, PanelLeft, Pencil, Phone, PhoneCall, Pin, Plus, Printer, Reply as ReplyIcon, Search, Send, Smile, Sparkles, Star, Trash2, UserRound, Users, Video, X } from "lucide-react";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { cairoInputToIso, formatCairoDateTime, formatCairoTime } from "@/lib/egyptianDate";
import { displayPhoneNumber } from "@/lib/egyptianPhoneFormatter";
import AccountSettingsModal from "./AccountSettingsModal";
import PushNotificationsButton from "./PushNotificationsButton";
import InstallAppButton from "./InstallAppButton";
import IncomingWhatsAppCallModal, { type IncomingCall } from "./IncomingWhatsAppCallModal";
import WhatsAppCallModal from "./WhatsAppCallModal";
import AgentQuickRepliesModal from "./AgentQuickRepliesModal";
import ProtectedMedia from "./ProtectedMedia";
import CopyableCustomerIdentities, { customerIdentityPreview } from "./CopyableCustomerIdentities";
import ImageEditorDialog from "./ImageEditorDialog";
import { hasMessageTextLinks, isNotificationSoundEnabled, latestOutgoingTextMessage, mergeMessages, mergePendingMessage, messageNotificationPreview, playIncomingMessageTone, setNotificationSoundEnabled, splitMessageTextLinks } from "@/lib/messageHelpers";
import { matchesCustomerPresence } from "@/lib/whatsappPresence";

type AnyRecord = Record<string, any>;
const channels = [{ id: "ALL", label: "الكل" }, { id: "WHATSAPP", label: "واتساب" }, { id: "MESSENGER", label: "ماسنجر" }, { id: "TELEGRAM", label: "تليجرام" }];
const commonReplyEmojis = ["😀", "😂", "😍", "🥰", "😊", "🙏", "👍", "👏", "❤️", "🎉", "✨", "🔥", "💯", "🌹", "✅", "🤔", "👋", "🤝"];
const CONVERSATION_SIDEBAR_WIDTH_KEY = "bondoq-conversation-sidebar-width";
const MIN_CONVERSATION_SIDEBAR_WIDTH = 220;
const MAX_CONVERSATION_SIDEBAR_WIDTH = 480;
const clampConversationSidebarWidth = (width: number) => Math.min(MAX_CONVERSATION_SIDEBAR_WIDTH, Math.max(MIN_CONVERSATION_SIDEBAR_WIDTH, Math.round(width)));
const productCategoryLabel: Record<string, string> = { EASTERN: "حلويات شرقية", WESTERN: "حلويات غربية", CAKES: "تورتات", BAKERY: "مخبوزات", KAHK: "كحك وبسكويت", CHOCOLATE: "شوكولاتة", MOULID: "حلاوة المولد", OCCASIONS: "مناسبات", MIX_BONDOQ: "ميكس بندق" };
const customerDisplayName = (customer?: AnyRecord | null) => customer?.displayName?.trim() || customer?.name || "عميل جديد";
const isWhatsAppGroupConversation = (conversation?: AnyRecord | null) => conversation?.channel === "WHATSAPP"
  && (String(conversation.externalConversationId || "").toLowerCase().endsWith("@g.us") || conversation.customer?.channelIdentifiers?.whatsappGroup === true);
export default function AgentWorkspace() {
  const router = useRouter();
  const [user, setUser] = useState<AnyRecord | null>(null);
  const [conversations, setConversations] = useState<AnyRecord[]>([]);
  const [activeId, setActiveId] = useState("");
  const [detail, setDetail] = useState<AnyRecord | null>(null);
  const [canned, setCanned] = useState<AnyRecord[]>([]);
  const [agentQuickReplies, setAgentQuickReplies] = useState<AnyRecord[]>([]);
  const [showQuickReplyManager, setShowQuickReplyManager] = useState(false);
  const [pendingQuickReply, setPendingQuickReply] = useState<AnyRecord | null>(null);
  const [products, setProducts] = useState<AnyRecord[]>([]);
  const [showProducts, setShowProducts] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptionsText, setPollOptionsText] = useState("");
  const [sendingPoll, setSendingPoll] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showConversationSidebar, setShowConversationSidebar] = useState(true);
  const [conversationSidebarWidth, setConversationSidebarWidth] = useState(285);
  const [conversationSidebarWidthLoaded, setConversationSidebarWidthLoaded] = useState(false);
  const [resizingConversationSidebar, setResizingConversationSidebar] = useState(false);
  const workspaceGridRef = useRef<HTMLElement | null>(null);
  const sidebarResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const sidebarWidthDraftRef = useRef(285);
  const [showCustomerSidebar, setShowCustomerSidebar] = useState(false);
  const [showEventComposer, setShowEventComposer] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventEndsAt, setEventEndsAt] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [eventDetails, setEventDetails] = useState("");
  const [showAiImageComposer, setShowAiImageComposer] = useState(false);
  const [aiImagePrompt, setAiImagePrompt] = useState("");
  const [generatingAiImage, setGeneratingAiImage] = useState(false);
  const [productFilter, setProductFilter] = useState("ALL");
  const [productSearch, setProductSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [whatsappGroupFilter, setWhatsappGroupFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [messageFilter, setMessageFilter] = useState("ALL");
  const [chatLoadError, setChatLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<AnyRecord[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState("");
  const [globalSearchHasMore, setGlobalSearchHasMore] = useState(false);
  const [phoneSearchResult, setPhoneSearchResult] = useState<AnyRecord | null>(null);
  const [phoneSearchError, setPhoneSearchError] = useState("");
  const [searchingPhone, setSearchingPhone] = useState(false);
  const phoneSearchRequestRef = useRef(0);
  const globalSearchRequestRef = useRef(0);
  const conversationSearchRequestRef = useRef(0);
  const pendingMessageJumpRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const [startingPhoneChat, setStartingPhoneChat] = useState(false);
  const [chatFontSize, setChatFontSize] = useState(15);
  const [text, setTextState] = useState("");
  const replyDraftRevisionRef = useRef(0);
  function setText(next: string | ((current: string) => string)) {
    replyDraftRevisionRef.current += 1;
    setTextState(next);
  }
  const [showCanned, setShowCanned] = useState(false);
  const [cannedReplyIndex, setCannedReplyIndex] = useState(0);
  const [showContacts, setShowContacts] = useState(false);
  const [showContactCard, setShowContactCard] = useState(false);
  const [sendingContactId, setSendingContactId] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<AnyRecord[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [presence, setPresence] = useState("ONLINE");
  const [watching, setWatching] = useState(false);
  const [customerActivity, setCustomerActivity] = useState<"typing" | "recording" | "">("");
  const [conversationActivities, setConversationActivities] = useState<Record<string, AnyRecord>>({});
  const customerActivityTimersRef = useRef(new Map<string, number>());
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
  const [secretNote, setSecretNote] = useState("");
  const [privateNoteMode, setPrivateNoteMode] = useState(false);
  const [privateNoteRecipients, setPrivateNoteRecipients] = useState<AnyRecord[]>([]);
  const [privateNoteRecipientId, setPrivateNoteRecipientId] = useState("");
  const [sendingSecretNote, setSendingSecretNote] = useState(false);
  const [replyingTo, setReplyingTo] = useState<AnyRecord | null>(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [deletingSelectedMessages, setDeletingSelectedMessages] = useState(false);
  const [forwardingMessages, setForwardingMessages] = useState(false);
  const [forwardMessage, setForwardMessage] = useState<AnyRecord | null>(null);
  const [forwardQuery, setForwardQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [starredMessages, setStarredMessages] = useState<AnyRecord[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [favoriteCustomerIds, setFavoriteCustomerIds] = useState<string[]>([]);
  const [mutedConversationIds, setMutedConversationIds] = useState<string[]>([]);
  const [conversationLists, setConversationLists] = useState<AnyRecord[]>([]);
  const [openConversationMenuId, setOpenConversationMenuId] = useState("");
  const [listMenuConversationId, setListMenuConversationId] = useState("");
  const [swipedConversationId, setSwipedConversationId] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [savingCustomerFavorite, setSavingCustomerFavorite] = useState(false);
  const [savingCustomerFlags, setSavingCustomerFlags] = useState(false);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [lightboxImage, setLightboxImage] = useState("");
  const [imageEditor, setImageEditor] = useState<{ file: File; url: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [requestingRecording, setRequestingRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [failedRecording, setFailedRecording] = useState<{ file: File; previewUrl: string; conversationId: string } | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [sending, setSending] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showMobileProfile, setShowMobileProfile] = useState(false);
  const [callConversation, setCallConversation] = useState<AnyRecord | null>(null);
  const [showHeaderOptions, setShowHeaderOptions] = useState(false);
  const [showConversationSearch, setShowConversationSearch] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchMatches, setConversationSearchMatches] = useState<AnyRecord[]>([]);
  const [conversationSearchTotal, setConversationSearchTotal] = useState(0);
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const [conversationSearchLoading, setConversationSearchLoading] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState("");
  const [hasMoreNewerMessages, setHasMoreNewerMessages] = useState(false);
  const [loadingNewerMessages, setLoadingNewerMessages] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffColleagues, setHandoffColleagues] = useState<AnyRecord[]>([]);
  const [handoffBusyId, setHandoffBusyId] = useState("");
  const [loadingHandoffColleagues, setLoadingHandoffColleagues] = useState(false);
  const [handoffError, setHandoffError] = useState<{ conversationId: string; message: string } | null>(null);
  const [incomingHandoffs, setIncomingHandoffs] = useState<AnyRecord[]>([]);
  const [handoffResponseBusyId, setHandoffResponseBusyId] = useState("");
  const [handoffResponseDecision, setHandoffResponseDecision] = useState<"ACCEPT" | "DECLINE" | "">("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [sendingProducts, setSendingProducts] = useState(false);
  const conversationMenuRef = useRef<HTMLDivElement | null>(null);
  const conversationGestureRef = useRef<{ id: string; x: number; y: number; pointerType: string } | null>(null);
  const conversationLongPressTimerRef = useRef<number | null>(null);
  const suppressConversationClickRef = useRef(false);
  const mutedConversationIdsRef = useRef(new Set<string>());
  const presenceRef = useRef("ONLINE");
  const sendingRef = useRef(false);
  const detailRequest = useRef(0);
  const detailLoadingIdRef = useRef("");
  const loadingMessagesRef = useRef(new Map<string, AnyRecord[]>());
  const notifiedMessagesRef = useRef(new Set<string>());
  const activeOutgoingClientIdsRef = useRef(new Set<string>());
  const pendingServerMessageIdsRef = useRef(new Map<string, string>());
  const chatLoadRequest = useRef(0);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const historyModeRef = useRef(false);
  historyModeRef.current = statusFilter === "HISTORY";
  const teamModeRef = useRef(false);
  teamModeRef.current = statusFilter === "TEAM";
  const archivedModeRef = useRef(false);
  archivedModeRef.current = statusFilter === "ARCHIVED";
  mutedConversationIdsRef.current = new Set(mutedConversationIds);
  const chatScopeRef = useRef("OWN");
  const conversationChannelFilterRef = useRef(filter);
  conversationChannelFilterRef.current = filter;
  const whatsappGroupFilterRef = useRef(whatsappGroupFilter);
  whatsappGroupFilterRef.current = whatsappGroupFilter;
  const loadedExtraChatsRef = useRef(false);
  const socketRef = useRef<Socket | null>(null);
  const activeIdRef = useRef("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const headerOptionsRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const stickerPickerRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const conversationSearchInputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const stickerInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const imageEditorResolverRef = useRef<((file: File | null) => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartRef = useRef(false);
  const recordingCancelledRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const agentPresenceRef = useRef<{ conversationId: string; activity: "composing" | "recording" | "paused"; sentAt: number }>({ conversationId: "", activity: "paused", sentAt: 0 });
  const agentPresenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [order, setOrder] = useState({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "", deposit: "" });

  function buildConversationListParams(limit: number, cursor?: string, history = historyModeRef.current, team = teamModeRef.current) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    if (team) params.set("team", "1");
    else if (history) params.set("history", "1");
    const channel = conversationChannelFilterRef.current;
    if (channel !== "ALL") params.set("channel", channel);
    const groups = whatsappGroupFilterRef.current;
    if (groups !== "ALL") params.set("whatsappGroups", groups === "GROUPS" ? "1" : "0");
    if (archivedModeRef.current) params.set("archived", "1");
    return params;
  }
  function resetChatList() {
    loadedExtraChatsRef.current = false;
    conversationsRef.current = [];
    setConversations([]);
    setChatCursor(null);
    setHasMoreChats(false);
  }
  async function loadChats(history = historyModeRef.current, team = teamModeRef.current) {
    const scope = team ? "TEAM" : history ? "HISTORY" : "OWN";
    const request = ++chatLoadRequest.current;
    try {
      const params = buildConversationListParams(50, undefined, history, team);
      const page = await api(`/api/conversations?${params}`);
      if (request === chatLoadRequest.current && scope === chatScopeRef.current) {
        const fresh = page.items || [];
        setConversations((current) => {
          const refreshed = chatScopeRef.current === scope && loadedExtraChatsRef.current
            ? [...fresh, ...current.filter((item: AnyRecord) => !fresh.some((next: AnyRecord) => next.id === item.id))]
            : fresh;
          const sorted = refreshed.sort((left: AnyRecord, right: AnyRecord) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt) || String(right.id).localeCompare(String(left.id)));
          conversationsRef.current = sorted;
          return sorted;
        });
        chatScopeRef.current = scope;
        setChatCursor(page.nextCursor || null); setHasMoreChats(Boolean(page.hasMore)); setChatLoadError("");
        if (!page.hasMore) loadedExtraChatsRef.current = false;
      }
      return page;
    } catch (error) {
      if (request === chatLoadRequest.current) setChatLoadError(error instanceof Error ? error.message : "تعذر تحديث المحادثات");
      return null;
    }
  }
  async function loadMoreChats() {
    if (!chatCursor || loadingMoreChats) return;
    const request = chatLoadRequest.current;
    const scope = chatScopeRef.current;
    setLoadingMoreChats(true);
    try {
      const params = buildConversationListParams(50, chatCursor, scope === "HISTORY", scope === "TEAM");
      const page = await api(`/api/conversations?${params}`);
      if (request !== chatLoadRequest.current || scope !== chatScopeRef.current) return;
      setConversations((current) => {
        const known = new Set(current.map((item: AnyRecord) => item.id));
        const merged = [...current, ...(page.items || []).filter((item: AnyRecord) => !known.has(item.id))];
        conversationsRef.current = merged;
        return merged;
      });
      loadedExtraChatsRef.current = true;
      setChatCursor(page.nextCursor || null); setHasMoreChats(Boolean(page.hasMore)); setChatLoadError("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل محادثات إضافية"); }
    finally { setLoadingMoreChats(false); }
  }
  async function loadStarredMessages() {
    try { setStarredMessages(await api<AnyRecord[]>("/api/me/starred-messages")); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل الرسائل المميزة"); }
  }
  function selectStatusFilter(next: string) {
    if (next === "STARRED") {
      setStatusFilter(next);
      void loadStarredMessages();
      return;
    }
    const history = next === "HISTORY";
    const team = next === "TEAM";
    const wasArchived = statusFilter === "ARCHIVED";
    const archived = next === "ARCHIVED";
    const scope = team ? "TEAM" : history ? "HISTORY" : "OWN";
    archivedModeRef.current = archived;
    setStatusFilter(next);
    if (scope !== chatScopeRef.current || history || team || archived || wasArchived) {
      historyModeRef.current = history;
      teamModeRef.current = team;
      chatScopeRef.current = scope;
      loadedExtraChatsRef.current = false;
      conversationsRef.current = [];
      setConversations([]);
      setChatCursor(null);
      setHasMoreChats(false);
      void loadChats(history, team);
    }
  }
  function selectChannelFilter(next: string) {
    conversationChannelFilterRef.current = next;
    whatsappGroupFilterRef.current = "ALL";
    setFilter(next);
    setWhatsappGroupFilter("ALL");
    resetChatList();
    void loadChats();
  }
  function selectWhatsAppConversationKind(next: "ALL" | "DIRECT" | "GROUPS") {
    const team = next === "GROUPS";
    chatScopeRef.current = team ? "TEAM" : "OWN";
    conversationChannelFilterRef.current = "WHATSAPP";
    whatsappGroupFilterRef.current = next;
    historyModeRef.current = false;
    teamModeRef.current = team;
    archivedModeRef.current = false;
    setFilter("WHATSAPP");
    setWhatsappGroupFilter(next);
    setStatusFilter(team ? "TEAM" : "ALL");
    resetChatList();
    void loadChats(false, team);
  }
  async function openChat(id: string, targetMessageId?: string) {
    pendingMessageJumpRef.current = null;
    setSelectionMode(false);
    setSelectedMessageIds([]);
    if (activeIdRef.current && activeIdRef.current !== id) socketRef.current?.emit("conversation:leave", activeIdRef.current);
    if (detailLoadingIdRef.current && detailLoadingIdRef.current !== id) loadingMessagesRef.current.delete(detailLoadingIdRef.current);
    if (activeId !== id) { setOrder({ product: "تورتة", size: "", filling: "", cakeMessage: "", deliveryAt: "", deliveryAddress: "", notes: "", price: "", deposit: "" }); setSelectedProductIds([]); }
    const request = ++detailRequest.current;
    activeIdRef.current = id; detailLoadingIdRef.current = id; stickToBottom.current = !targetMessageId; setShowJumpToBottom(false); setShowMobileProfile(false); setShowCustomerSidebar(false); setShowHeaderOptions(false); setShowConversationSearch(false); setShowStickerPicker(false); setCustomerActivity(""); setConversationSearchQuery(""); setConversationSearchMatches([]); setHighlightedMessageId(targetMessageId || ""); setHasMoreNewerMessages(false); setActiveId(id); setDetail(null); setNotice(""); setSecretNote(""); setPrivateNoteMode(false);
    if (targetMessageId) { setMessageFilter("ALL"); pendingMessageJumpRef.current = { conversationId: id, messageId: targetMessageId }; }
    socketRef.current?.emit("conversation:join", id);
    try {
      const [conversation, aroundPage] = await Promise.all([
        api(`/api/conversations/${id}?messageLimit=50`),
        targetMessageId ? api(`/api/conversations/${id}/messages?around=${encodeURIComponent(targetMessageId)}&limit=50`) : Promise.resolve(null)
      ]);
      if (request === detailRequest.current) {
        const queuedMessages = loadingMessagesRef.current.get(id) || [];
        loadingMessagesRef.current.delete(id); detailLoadingIdRef.current = "";
        setDetail({ ...conversation, messages: mergeMessages(aroundPage?.messages || conversation.messages || [], queuedMessages), hasMoreMessages: aroundPage?.hasMore ?? conversation.hasMoreMessages, hasMoreAfterMessages: Boolean(aroundPage?.hasMoreAfter), nextAfterMessageId: aroundPage?.nextAfter || null }); setHasMoreNewerMessages(Boolean(aroundPage?.hasMoreAfter)); setSavedOrder(null);
        conversationsRef.current = conversationsRef.current.map((chat) => chat.id === id ? { ...chat, personalState: conversation.personalState, unreadCount: conversation.unreadCount } : chat);
        setConversations(conversationsRef.current);
      }
    } catch (error) { if (request === detailRequest.current) { detailLoadingIdRef.current = ""; setNotice(error instanceof Error ? error.message : "تعذر فتح المحادثة"); } }
  }
  async function startChatFromContact(contact: AnyRecord) {
    if (user?.channelAccess ? user.channelAccess.WHATSAPP !== "FULL" : user?.canReceiveWhatsApp === false) { setNotice("حسابك غير مخصص لبدء محادثة WhatsApp."); return; }
    try {
      const result = await api<{ conversationId: string }>(`/api/contacts/${contact.id}/whatsapp-conversation`, { method: "POST", body: JSON.stringify({}) });
      setShowContacts(false);
      await openChat(result.conversationId);
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر فتح محادثة WhatsApp لهذا العميل"); }
  }
  async function searchPhoneHistory() {
    if (searchingPhone) return;
    const query = search.trim();
    if (search.replace(/[^\d٠-٩۰-۹]/g, "").length < 7) {
      setPhoneSearchResult(null);
      setPhoneSearchError("اكتب رقم الهاتف كاملًا مع رمز الدولة، ثم ابحث في السجل.");
      return;
    }
    const request = ++phoneSearchRequestRef.current;
    setSearchingPhone(true);
    setPhoneSearchError("");
    setPhoneSearchResult(null);
    try {
      const result = await api<AnyRecord>(`/api/contacts/phone-search?phone=${encodeURIComponent(query)}`);
      if (request === phoneSearchRequestRef.current) setPhoneSearchResult(result);
    } catch (error) {
      if (request === phoneSearchRequestRef.current) {
        setPhoneSearchResult(null);
        setPhoneSearchError(error instanceof Error ? error.message : "تعذر البحث عن هذا الرقم");
      }
    } finally { if (request === phoneSearchRequestRef.current) setSearchingPhone(false); }
  }
  function buildGlobalSearchParams(query: string, offset = 0) {
    const params = new URLSearchParams({ q: query, offset: String(offset) });
    const channel = conversationChannelFilterRef.current;
    if (channel !== "ALL") params.set("channel", channel);
    const groups = whatsappGroupFilterRef.current;
    if (groups !== "ALL") params.set("whatsappGroups", groups === "GROUPS" ? "1" : "0");
    return params;
  }
  async function loadMoreGlobalSearch() {
    const query = search.trim();
    if (!query || !globalSearchHasMore || globalSearchLoading) return;
    const request = globalSearchRequestRef.current;
    setGlobalSearchLoading(true);
    setGlobalSearchError("");
    try {
      const page = await api(`/api/conversations/search?${buildGlobalSearchParams(query, globalSearchResults.length)}`);
      if (request !== globalSearchRequestRef.current) return;
      setGlobalSearchResults((current) => [...current, ...(page.items || [])]);
      setGlobalSearchHasMore(Boolean(page.hasMore));
    } catch (error) { if (request === globalSearchRequestRef.current) setGlobalSearchError(error instanceof Error ? error.message : "تعذر تحميل نتائج إضافية"); }
    finally { if (request === globalSearchRequestRef.current) setGlobalSearchLoading(false); }
  }
  async function startChatFromPhone() {
    if (!phoneSearchResult?.phone || startingPhoneChat || (user?.channelAccess ? user.channelAccess.WHATSAPP !== "FULL" : user?.canReceiveWhatsApp === false)) return;
    setStartingPhoneChat(true);
    try {
      const result = await api<{ conversationId: string; created: boolean; readOnly?: boolean }>("/api/contacts/whatsapp-conversation", {
        method: "POST", body: JSON.stringify({ phone: phoneSearchResult.phone })
      });
      setPhoneSearchResult(null);
      setPhoneSearchError("");
      await openChat(result.conversationId);
      void loadChats();
    } catch (error) { setPhoneSearchError(error instanceof Error ? error.message : "تعذر بدء محادثة WhatsApp لهذا الرقم"); }
    finally { setStartingPhoneChat(false); }
  }
  async function sendContactCard(contact: AnyRecord) {
    if (!activeId || !contact.phone || sendingContactId) return;
    const conversationId = activeId;
    setSendingContactId(contact.id);
    try {
      const message = await api(`/api/conversations/${conversationId}/contact-card`, { method: "POST", body: JSON.stringify({ contactId: contact.id }) });
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: mergeMessages(current.messages || [], message) } : current);
      setShowContactCard(false);
      setNotice(`تمت إضافة بطاقة ${customerDisplayName(contact)} إلى قائمة الإرسال.`);
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إرسال بطاقة جهة الاتصال"); }
    finally { setSendingContactId(""); }
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
    const conversationId = activeId;
    if (!conversationId) return;
    setHandoffError(null);
    setHandoffColleagues([]);
    setLoadingHandoffColleagues(true);
    setShowHandoff(true);
    try {
      const colleagues = await api(`/api/agents/customer-care-colleagues?conversationId=${encodeURIComponent(conversationId)}`);
      setHandoffColleagues(colleagues);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر تحميل الموظفين المؤهلين";
      setHandoffError({ conversationId, message });
      setNotice(message);
    } finally { setLoadingHandoffColleagues(false); }
  }
  async function handoffToColleague(agentId: string, agentName: string) {
    if (!activeId || handoffBusyId) return;
    const conversationId = activeId;
    setHandoffError(null);
    setHandoffBusyId(agentId);
    try {
      await api(`/api/conversations/${conversationId}/handoff`, { method: "POST", body: JSON.stringify({ agentId }) });
      setShowHandoff(false);
      setNotice(`أُرسل طلب التحويل إلى ${agentName}. ستبقى المحادثة لديك حتى يقبله الزميل.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر تحويل المحادثة للزميل";
      setHandoffError({ conversationId, message });
      setNotice(message);
      void api(`/api/agents/customer-care-colleagues?conversationId=${encodeURIComponent(conversationId)}`).then(setHandoffColleagues).catch(() => {});
    }
    finally { setHandoffBusyId(""); }
  }

  async function respondToHandoff(request: AnyRecord, decision: "ACCEPT" | "DECLINE") {
    const conversationId = request.conversationId;
    if (handoffResponseBusyId) return;
    setHandoffError(null);
    setHandoffResponseBusyId(conversationId);
    setHandoffResponseDecision(decision);
    try {
      await api(`/api/conversations/${conversationId}/handoff-response`, { method: "POST", body: JSON.stringify({ decision }) });
      setIncomingHandoffs((current) => current.filter((item) => item.conversationId !== conversationId));
      if (decision === "ACCEPT") {
        setNotice("قبلت طلب التحويل وأصبحت المحادثة ضمن محادثاتك.");
        await loadChats();
        void openChat(conversationId);
       } else setNotice("رُفض الطلب وعادت المحادثة إلى زميلك؛ يمكنه تحويلها لزميل آخر أو متابعتها.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر الرد على طلب التحويل";
      setHandoffError({ conversationId, message });
      setNotice(message);
    }
    finally { setHandoffResponseBusyId(""); setHandoffResponseDecision(""); }
  }

  async function toggleFavorite() {
    if (!activeId) return;
    await toggleConversationFavorite(activeId);
  }

  async function toggleConversationFavorite(conversationId: string) {
    const favorite = !favoriteIds.includes(conversationId);
    try {
      await api(`/api/conversations/${conversationId}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
      setFavoriteIds((old) => favorite ? [...new Set([...old, conversationId])] : old.filter((id) => id !== conversationId));
      setOpenConversationMenuId("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث المفضلة"); }
  }

  async function updatePersonalConversationSettings(conversationId: string, changes: AnyRecord, successMessage: string) {
    try {
      const result = await api(`/api/conversations/${conversationId}/personal-settings`, { method: "PATCH", body: JSON.stringify(changes) });
      const removeFromCurrentView = changes.isDeleted === true || changes.isArchived === true || changes.isArchived === false && statusFilter === "ARCHIVED";
      if (removeFromCurrentView) {
        conversationsRef.current = conversationsRef.current.filter((chat) => chat.id !== conversationId);
        setConversations(conversationsRef.current);
      } else {
        setConversations((current) => current.map((chat) => chat.id === conversationId ? { ...chat, personalState: result.personalState, unreadCount: changes.markRead ? 0 : chat.unreadCount } : chat));
      }
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, personalState: result.personalState, unreadCount: changes.markRead ? 0 : current.unreadCount } : current);
      if (changes.isMuted !== undefined) {
        const nextMutedIds = changes.isMuted ? [...new Set([...mutedConversationIdsRef.current, conversationId])] : [...mutedConversationIdsRef.current].filter((id) => id !== conversationId);
        mutedConversationIdsRef.current = new Set(nextMutedIds);
        setMutedConversationIds(nextMutedIds);
        if (changes.isMuted) setIncomingNotice((current) => current?.conversationId === conversationId ? null : current);
      }
      if (changes.isDeleted) {
        if (activeIdRef.current === conversationId) returnToChatList();
      }
      if (changes.clear && activeIdRef.current === conversationId) {
        const refreshed = await api(`/api/conversations/${conversationId}?messageLimit=50`);
        setDetail((current: AnyRecord) => current?.id === conversationId ? refreshed : current);
      }
      setOpenConversationMenuId("");
      setListMenuConversationId("");
      setNotice(successMessage);
      void loadChats();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر تحديث إعداد المحادثة");
      return false;
    }
  }

  async function toggleConversationBlock(chat: AnyRecord) {
    const customerId = chat.customer?.id;
    if (!customerId || savingCustomerFlags) return;
    const nextValue = !chat.customer?.isBlocked;
    if (nextValue && !window.confirm("حظر هذا العميل للجميع؟ سيُمنع إرسال الردود إليه، وستُحفظ رسائله الواردة للمراجعة الإدارية.")) return;
    setSavingCustomerFlags(true);
    try {
      const customer = await api(`/api/customers/${customerId}/flags`, { method: "PATCH", body: JSON.stringify({ isBlocked: nextValue }) });
      setConversations((current) => current.map((item) => item.customer?.id === customerId ? { ...item, customer: { ...item.customer, ...customer } } : item));
      setDetail((current: AnyRecord) => current?.customer?.id === customerId ? { ...current, customer: { ...current.customer, ...customer } } : current);
      setOpenConversationMenuId("");
      setNotice(nextValue ? "حُظر العميل للجميع." : "أُلغي حظر العميل للجميع.");
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث حالة العميل"); }
    finally { setSavingCustomerFlags(false); }
  }

  async function showConversationLists(conversationId: string) {
    if (listMenuConversationId === conversationId) { setListMenuConversationId(""); return; }
    try {
      const lists = await api<AnyRecord[]>("/api/conversation-lists");
      setConversationLists(lists);
      setListMenuConversationId(conversationId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل قوائمك الشخصية"); }
  }

  async function addConversationToList(conversationId: string, list: AnyRecord) {
    try {
      await api(`/api/conversation-lists/${list.id}/conversations`, { method: "PUT", body: JSON.stringify({ conversationId }) });
      setListMenuConversationId(""); setOpenConversationMenuId("");
      setNotice(`أُضيفت المحادثة إلى قائمة «${list.name}» في حسابك.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذرت إضافة المحادثة إلى القائمة"); }
  }

  async function createConversationListForChat(conversationId: string) {
    const name = window.prompt("اكتب اسم القائمة الشخصية:")?.trim();
    if (!name) return;
    try {
      let list = conversationLists.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!list) {
        const createdList = await api<AnyRecord>("/api/conversation-lists", { method: "POST", body: JSON.stringify({ name }) });
        list = createdList;
        setConversationLists((current) => [...current, createdList]);
      }
      await addConversationToList(conversationId, list);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إنشاء القائمة الشخصية"); }
  }

  function openConversationMenu(conversationId: string) {
    setSwipedConversationId("");
    setListMenuConversationId("");
    setOpenConversationMenuId((current) => current === conversationId ? "" : conversationId);
  }

  function startConversationGesture(event: ReactPointerEvent<HTMLElement>, conversationId: string) {
    if (!event.isPrimary || event.pointerType === "mouse" && event.button !== 0) return;
    if (conversationLongPressTimerRef.current !== null) window.clearTimeout(conversationLongPressTimerRef.current);
    const gesture = { id: conversationId, x: event.clientX, y: event.clientY, pointerType: event.pointerType };
    conversationGestureRef.current = gesture;
    if (event.pointerType !== "mouse") {
      conversationLongPressTimerRef.current = window.setTimeout(() => {
        if (conversationGestureRef.current?.id !== conversationId) return;
        suppressConversationClickRef.current = true;
        openConversationMenu(conversationId);
      }, 550);
    }
  }

  function moveConversationGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = conversationGestureRef.current;
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      if (conversationLongPressTimerRef.current !== null) window.clearTimeout(conversationLongPressTimerRef.current);
      conversationLongPressTimerRef.current = null;
    }
    if (gesture.pointerType !== "mouse" && dx < -56 && Math.abs(dx) > Math.abs(dy)) {
      suppressConversationClickRef.current = true;
      setSwipedConversationId(gesture.id);
    }
  }

  function endConversationGesture() {
    if (conversationLongPressTimerRef.current !== null) window.clearTimeout(conversationLongPressTimerRef.current);
    conversationLongPressTimerRef.current = null;
    conversationGestureRef.current = null;
    if (suppressConversationClickRef.current) window.setTimeout(() => { suppressConversationClickRef.current = false; }, 350);
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
  async function loadNewerMessages() {
    const conversationId = detail?.id;
    const lastMessage = detail?.messages?.[detail.messages.length - 1];
    if (!conversationId || !lastMessage?.id || !hasMoreNewerMessages || loadingNewerMessages) return;
    setLoadingNewerMessages(true);
    try {
      const params = new URLSearchParams({ after: lastMessage.id, limit: "50" });
      const page = await api(`/api/conversations/${conversationId}/messages?${params}`);
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: mergeMessages(current.messages || [], page.messages || []) } : current);
      setHasMoreNewerMessages(Boolean(page.hasMoreAfter));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحميل الرسائل الأحدث"); }
    finally { setLoadingNewerMessages(false); }
  }
  async function jumpToMessage(messageId: string) {
    const conversationId = detail?.id;
    if (!conversationId || !messageId) return;
    stickToBottom.current = false;
    setMessageFilter("ALL");
    setHighlightedMessageId(messageId);
    const scrollToMatch = () => requestAnimationFrame(() => {
      const element = document.getElementById(`message-${messageId}`);
      if (element) { element.scrollIntoView({ behavior: "smooth", block: "center" }); setShowJumpToBottom(false); }
    });
    if (detail.messages?.some((message: AnyRecord) => message.id === messageId)) { scrollToMatch(); return; }
    try {
      const params = new URLSearchParams({ around: messageId, limit: "50" });
      const page = await api(`/api/conversations/${conversationId}/messages?${params}`);
      pendingMessageJumpRef.current = { conversationId, messageId };
      setHasMoreNewerMessages(Boolean(page.hasMoreAfter));
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: page.messages || [], hasMoreMessages: Boolean(page.hasMore), hasMoreAfterMessages: Boolean(page.hasMoreAfter), nextAfterMessageId: page.nextAfter || null } : current);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر فتح الرسالة المطابقة"); }
  }
  async function moveConversationSearchMatch(direction: -1 | 1) {
    const nextIndex = conversationSearchIndex + direction;
    if (nextIndex < 0 || nextIndex >= conversationSearchTotal) return;
    if (nextIndex < conversationSearchMatches.length) {
      setConversationSearchIndex(nextIndex);
      void jumpToMessage(conversationSearchMatches[nextIndex].id);
      return;
    }
    if (!detail?.id || conversationSearchLoading) return;
    const request = conversationSearchRequestRef.current;
    setConversationSearchLoading(true);
    try {
      const params = new URLSearchParams({ q: conversationSearchQuery.trim(), conversationId: detail.id, offset: String(conversationSearchMatches.length) });
      const page = await api(`/api/conversations/search?${params}`);
      if (request !== conversationSearchRequestRef.current) return;
      const matches = [...conversationSearchMatches, ...(page.items || [])];
      setConversationSearchMatches(matches);
      if (matches[nextIndex]) { setConversationSearchIndex(nextIndex); void jumpToMessage(matches[nextIndex].id); }
    } catch (error) { if (request === conversationSearchRequestRef.current) setNotice(error instanceof Error ? error.message : "تعذر تحميل نتيجة البحث التالية"); }
    finally { if (request === conversationSearchRequestRef.current) setConversationSearchLoading(false); }
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

  async function sendSecretNote(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const conversationId = activeId;
    const recipientId = privateNoteRecipientId;
    const noteText = secretNote.trim();
    if (!conversationId || !recipientId || !noteText || sendingSecretNote) return;
    setSendingSecretNote(true);
    try {
      const note = await api(`/api/conversations/${conversationId}/private-notes`, { method: "POST", body: JSON.stringify({ recipientId, text: noteText }) });
      setDetail((current: AnyRecord) => current?.id === conversationId && !current.privateNotes?.some((item: AnyRecord) => item.id === note.id) ? { ...current, privateNotes: [...(current.privateNotes || []), note] } : current);
      setSecretNote("");
      setPrivateNoteMode(false);
      setNotice(`تم إرسال رسالة سرية إلى ${note.recipient?.name || "الزميل"}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إرسال الرسالة السرية"); }
    finally { setSendingSecretNote(false); }
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

  async function toggleMessageStar(message: AnyRecord) {
    if (!activeId) return;
    const currentlyStarred = starredMessages.some((item) => item.id === message.id);
    try {
      await api(`/api/conversations/${activeId}/messages/${message.id}/star`, { method: "PUT", body: JSON.stringify({ starred: !currentlyStarred }) });
      if (currentlyStarred) setStarredMessages((current) => current.filter((item) => item.id !== message.id));
      else {
        const conversation = { id: detail.id, channel: detail.channel, customer: detail.customer, lastMessageAt: detail.lastMessageAt };
        setStarredMessages((current) => [{ id: message.id, starredAt: new Date().toISOString(), conversationId: activeId, conversation, message }, ...current.filter((item) => item.id !== message.id)].slice(0, 200));
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الرسالة المميزة"); }
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
    if (!activeId || deletingMessageId || deletingSelectedMessages) return;
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
  function toggleMessageSelection(messageId: string) {
    setSelectionMode(true);
    setSelectedMessageIds((current) => current.includes(messageId) ? current.filter((id) => id !== messageId) : [...current, messageId]);
  }
  function clearMessageSelection() {
    setSelectedMessageIds([]);
    setSelectionMode(false);
  }
  async function copySelectedMessages() {
    if (!selectedMessages.length) return;
    const copyText = selectedMessages.map((message: AnyRecord) => {
      const label = ({ IMAGE: "[صورة]", STICKER: "[ملصق]", AUDIO: "[رسالة صوتية]", VIDEO: "[فيديو]", FILE: "[ملف]", LOCATION: "[موقع]", POLL: "[استطلاع]", SYSTEM: "[رسالة نظام]" } as Record<string, string>)[message.kind] || "[رسالة]";
      return `${message.author?.name || (message.direction === "OUTBOUND" ? "الموظف" : "العميل")} · ${formatCairoTime(message.createdAt)}\n${message.text?.trim() || label}`;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(copyText);
      setNotice(`تم نسخ ${selectedMessages.length} رسالة.`);
      clearMessageSelection();
    } catch {
      setNotice("تعذر النسخ من المتصفح. تحقق من إذن الحافظة ثم حاول مجددًا.");
    }
  }
  async function deleteSelectedMessages() {
    if (!activeId || deletingSelectedMessages || deletingMessageId || !deletableSelectedMessages.length) return;
    const targets = deletableSelectedMessages;
    if (!window.confirm(`حذف ${targets.length} رسالة من المحادثة والقناة؟ لا يمكن التراجع عن الحذف.`)) return;
    const conversationId = activeId;
    setDeletingSelectedMessages(true);
    const deletedIds: string[] = [];
    for (const message of targets) {
      try {
        await api(`/api/conversations/${conversationId}/messages/${message.id}`, { method: "DELETE" });
        deletedIds.push(message.id);
      } catch { /* Keep processing the remaining selected messages. */ }
    }
    if (deletedIds.length) {
      setDetail((current: AnyRecord) => current?.id === conversationId ? { ...current, messages: (current.messages || []).filter((message: AnyRecord) => !deletedIds.includes(message.id)) } : current);
      setSelectedMessageIds((current) => current.filter((id) => !deletedIds.includes(id)));
      if (deletedIds.length === selectedMessages.length) setSelectionMode(false);
    }
    setNotice(deletedIds.length === targets.length
      ? `حُذفت ${deletedIds.length} رسالة من المحادثة والقناة.`
      : deletedIds.length
        ? `حُذفت ${deletedIds.length} رسالة، وتعذر حذف ${targets.length - deletedIds.length} أخرى.`
        : "تعذر حذف الرسائل المحددة.");
    setDeletingSelectedMessages(false);
  }
  async function forwardMessageTo(target: AnyRecord) {
    if (!forwardMessage || forwardingMessages) return;
    const source = forwardMessage;
    const messages = Array.isArray(source.messages) ? source.messages : [source];
    setForwardingMessages(true);
    let forwarded = 0;
    let failureMessage = "";
    for (const message of messages) {
      try {
        const sent = await api(`/api/conversations/${source.conversationId}/messages/${message.id}/forward`, { method: "POST", body: JSON.stringify({ targetConversationId: target.id }) });
        setDetail((current: AnyRecord) => current?.id === target.id ? { ...current, messages: mergeMessages(current.messages || [], sent) } : current);
        forwarded += 1;
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : "تعذر تحويل الرسائل المحددة.";
      }
    }
    setForwardingMessages(false);
    if (!forwarded) { setNotice(failureMessage || "تعذر تحويل الرسائل المحددة."); return; }
    setForwardMessage(null); setForwardQuery("");
    if (Array.isArray(source.messages)) clearMessageSelection();
    setNotice(forwarded === messages.length ? `تم تحويل ${forwarded} رسالة إلى ${customerDisplayName(target.customer)}.` : `تم تحويل ${forwarded} من ${messages.length} رسالة؛ تعذر تحويل الباقي.`);
    void loadChats();
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

  async function sendEventCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = eventTitle.trim();
    if (!title || !eventStartsAt) return;
    if (eventEndsAt && new Date(eventEndsAt).getTime() < new Date(eventStartsAt).getTime()) {
      setNotice("يجب أن يكون وقت الانتهاء بعد وقت البداية.");
      return;
    }
    const lines = [
      `دعوة موعد: ${title}`,
      `البداية: ${formatCairoDateTime(cairoInputToIso(eventStartsAt))}`,
      ...(eventEndsAt ? [`النهاية: ${formatCairoDateTime(cairoInputToIso(eventEndsAt))}`] : []),
      ...(eventLocation.trim() ? [`المكان: ${eventLocation.trim()}`] : []),
      ...(eventDetails.trim() ? [`التفاصيل: ${eventDetails.trim()}`] : [])
    ];
    if (await deliverReply({ text: lines.join("\n") })) {
      setShowEventComposer(false);
      setEventTitle(""); setEventStartsAt(""); setEventEndsAt(""); setEventLocation(""); setEventDetails("");
    }
  }

  async function generateAndSendAiImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = aiImagePrompt.trim();
    const conversationId = activeId;
    if (!prompt || !conversationId || generatingAiImage) return;
    if (!messagingEnabled) { setNotice("لا يمكن الإرسال في هذه المحادثة حاليًا."); return; }
    setGeneratingAiImage(true);
    setNotice("جارٍ إنشاء الصورة...");
    try {
      const asset = await api<{ id: string }>(`/api/conversations/${conversationId}/ai-image`, {
        method: "POST", body: JSON.stringify({ prompt })
      });
      const sent = await deliverReply({ kind: "IMAGE", mediaAssetId: asset.id }, conversationId);
      if (sent) {
        setShowAiImageComposer(false);
        setAiImagePrompt("");
        setNotice("تم إنشاء الصورة وإضافتها إلى قائمة الإرسال.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر إنشاء الصورة. حاول مرة أخرى.");
    } finally { setGeneratingAiImage(false); }
  }

  useEffect(() => {
    if (!getToken()) return router.replace("/login");
    let connection: Socket | undefined;
    let current = true;
    const initialize = async () => {
      const [profile, muted] = await Promise.all([
        api("/api/auth/me"),
        api<{ conversationIds: string[] }>("/api/me/muted-conversations").catch(() => ({ conversationIds: [] }))
      ]);
      if (!current) return;
      if (profile.role !== "AGENT" && profile.role !== "BRANCH_USER") return router.replace("/admin/dashboard");
      setMutedConversationIds(muted.conversationIds || []);
      mutedConversationIdsRef.current = new Set(muted.conversationIds || []);
      setUser(profile); setPresence(profile.presence); presenceRef.current = profile.presence;
      connection = io(API_URL, { auth: { token: getToken() } }); socketRef.current = connection; setSocket(connection);
      connection.on("connect", () => {
        void api("/api/agents/me/connection-ready", { method: "POST", body: JSON.stringify({ presence: presenceRef.current }) })
          .then((response) => { presenceRef.current = response.presence; setPresence(response.presence); })
          .catch(() => {});
        void loadChats();
        if (activeIdRef.current) void openChat(activeIdRef.current);
      });
      connection.on("canned:updated", () => { void api("/api/canned-responses").then(setCanned).catch(() => {}); });
      connection.on("agent:quick-replies-updated", () => { void api("/api/agent/quick-replies").then(setAgentQuickReplies).catch(() => {}); });
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
         connection.on("message:status", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: (old.messages || []).map((message: AnyRecord) => message.id === event.message.id ? { ...message, deliveryStatus: event.message.deliveryStatus, deliveredAt: event.message.deliveredAt, readAt: event.message.readAt, playedAt: event.message.playedAt } : message) } : old));
        connection.on("customer_presence", (event) => {
          console.log("[PRESENCE RECEIVED]:", event);
          const activity = event?.activity === "recording" || event?.state === "recording" ? "recording"
            : event?.activity === "typing" || event?.state === "typing" || event?.state === "composing" ? "typing" : "";
          const conversationIds = new Set<string>();
          const directId = String(event?.chatId || event?.conversationId || "");
          if (directId) conversationIds.add(directId);
          for (const chat of conversationsRef.current) {
            if (matchesCustomerPresence(chat, event)) conversationIds.add(chat.id);
          }
          const activeId = activeIdRef.current;
          const activeChat = detailRef.current?.id === activeId
            ? detailRef.current
            : conversationsRef.current.find((chat) => chat.id === activeId);
          const activeMatches = conversationIds.has(activeId) || matchesCustomerPresence(activeChat, event);
          if (activeMatches && activeId) conversationIds.add(activeId);
          if (!conversationIds.size) return;

          for (const conversationId of conversationIds) {
            const previousTimer = customerActivityTimersRef.current.get(conversationId);
            if (previousTimer) window.clearTimeout(previousTimer);
            if (!activity) {
              customerActivityTimersRef.current.delete(conversationId);
              continue;
            }
            const timer = window.setTimeout(() => {
              if (customerActivityTimersRef.current.get(conversationId) !== timer) return;
              customerActivityTimersRef.current.delete(conversationId);
              setConversationActivities((current) => {
                if (current[conversationId]?.actor !== "customer") return current;
                const next = { ...current };
                delete next[conversationId];
                return next;
              });
              if (conversationId === activeIdRef.current) setCustomerActivity("");
            }, 8_000);
            customerActivityTimersRef.current.set(conversationId, timer);
          }
          setConversationActivities((current) => {
            const next = { ...current };
            for (const conversationId of conversationIds) {
              if (activity) next[conversationId] = { activity, actor: "customer" };
              else if (next[conversationId]?.actor === "customer") delete next[conversationId];
            }
            return next;
          });
          if (activeMatches) setCustomerActivity(activity);
        });
       connection.on("whatsapp:agent-activity", (event) => {
         setConversationActivities((current) => {
           const next = { ...current };
           if (event.activity === "typing" || event.activity === "recording") next[event.conversationId] = { activity: event.activity, actor: "agent", actorId: event.actorId, actorName: event.actorName };
           else if (!event.actorId || next[event.conversationId]?.actorId === event.actorId) delete next[event.conversationId];
           return next;
         });
       });
        connection.on("conversation:deleted", (event) => {
          void loadChats();
          if (event.conversationId === activeIdRef.current) {
            socketRef.current?.emit("conversation:leave", event.conversationId);
            activeIdRef.current = ""; setActiveId(""); setDetail(null);
          }
        });
      connection.on("conversation:assigned", (event) => {
        void loadChats();
        if (event.isAutoReassignment && event.assignedAgentId === profile.id) setIncomingNotice({ isAutoReassignment: true, conversationId: event.id, customerName: customerDisplayName(event.customer), channel: event.channel, preview: "أُعيد إسناد هذه المحادثة إليك لمتابعتها." });
      });
      connection.on("conversation:handoff", (event) => {
        void loadChats();
        setIncomingNotice({ isHandoff: true, conversationId: event.conversation.id, customerName: customerDisplayName(event.conversation.customer), channel: event.conversation.channel, preview: `حوّلها إليك ${event.fromAgentName || "زميلك"}.` });
      });
      connection.on("conversation:handoff-requested", (request) => {
        setIncomingHandoffs((current) => [request, ...current.filter((item) => item.conversationId !== request.conversationId)]);
        playIncomingMessageTone();
      });
      connection.on("conversation:handoff-declined", (event) => {
        setNotice(`رفض ${event.agentName || "الزميل"} استلام المحادثة؛ بقيت لديك ويمكنك تحويلها لزميل آخر.`);
        void loadChats();
      });
      connection.on("conversation:handoff-cancelled", (event) => {
        setIncomingHandoffs((current) => current.filter((item) => item.conversationId !== event.conversationId));
      });
      connection.on("conversation:admin-reassigned", (event) => {
        setIncomingNotice({ isHandoffSent: true, isAdminReassignment: true, conversationId: event.conversationId, customerName: event.customerName, preview: event.body });
      });
      connection.on("conversation:unassigned", (event) => {
        void loadChats();
        if (chatScopeRef.current === "OWN") setConversations((current) => {
          const next = current.filter((item: AnyRecord) => item.id !== event.id);
          conversationsRef.current = next;
          return next;
        });
        if (event.id === activeIdRef.current) {
          socketRef.current?.emit("conversation:leave", event.id);
          activeIdRef.current = "";
          setActiveId("");
          setDetail(null);
          setIncomingNotice({ isHandoffSent: true, conversationId: event.id, customerName: customerDisplayName(event.customer), channel: event.channel, preview: event.assignedAgent?.name ? `يتابع ${event.assignedAgent.name} هذه المحادثة الآن.` : "أُعيدت المحادثة إلى الطابور." });
        }
      });
      connection.on("message:new", (event) => {
        const conversationId = event.conversationId || event.conversation?.id;
        if (event.message?.direction !== "OUTBOUND" || event.message.authorId !== user?.id) void loadChats();
        if (event.message?.direction === "INBOUND" && conversationId && !mutedConversationIdsRef.current.has(conversationId)) {
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
        const clientMessageId = typeof event.clientMessageId === "string" ? event.clientMessageId : undefined;
        if (clientMessageId && event.message?.id && activeOutgoingClientIdsRef.current.has(clientMessageId)) {
          pendingServerMessageIdsRef.current.set(clientMessageId, event.message.id);
        }
        if (event.message && conversationId === detailLoadingIdRef.current) {
          loadingMessagesRef.current.set(conversationId, mergePendingMessage(loadingMessagesRef.current.get(conversationId) || [], event.message, clientMessageId));
        }
        if (event.message && conversationId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergePendingMessage(old.messages || [], event.message, clientMessageId), customer: event.customer || old.customer } : old);
      });
      connection.on("whatsapp:history-synced", ({ conversationIds = [] }) => {
        void loadChats();
        const conversationId = activeIdRef.current;
        if (!conversationId || !conversationIds.includes(conversationId)) return;
        void api(`/api/conversations/${conversationId}`).then((conversation) => {
          if (activeIdRef.current === conversationId) setDetail(conversation);
        }).catch(() => {});
      });
      connection.on("whatsapp:groups-synced", () => { void loadChats(); });
      connection.on("conversation:access-revoked", ({ conversationId }) => {
        if (activeIdRef.current === conversationId) {
          ++detailRequest.current;
          activeIdRef.current = "";
          detailLoadingIdRef.current = "";
          loadingMessagesRef.current.delete(conversationId);
          setActiveId("");
          setDetail(null);
          setNotice("تم نقل المحادثة إلى نطاق آخر ولم تعد لديك صلاحية عرضها.");
        }
        conversationsRef.current = conversationsRef.current.filter((item) => item.id !== conversationId);
        setConversations(conversationsRef.current);
        loadedExtraChatsRef.current = false;
        setChatCursor(null);
        setHasMoreChats(false);
        setIncomingNotice((current) => current?.conversationId === conversationId ? null : current);
        void loadChats();
      });
      connection.on("message:transcribed", (event) => setDetail((old: AnyRecord) => old?.id === event.conversationId ? { ...old, messages: mergeMessages(old.messages || [], event.message) } : old));
        connection.on("whisper:new", (note) => { setDetail((old: AnyRecord) => old?.id === note.conversationId ? { ...old, whisperNotes: [...(old.whisperNotes || []), note] } : old); setNotice("أرسل المدير توجيهًا سريًا جديدًا"); });
        connection.on("conversation-private-note:new", (event) => {
          const note = event.note;
          if (!event.conversationId || !note) return;
          setDetail((old: AnyRecord) => old?.id === event.conversationId && !old.privateNotes?.some((item: AnyRecord) => item.id === note.id) ? { ...old, privateNotes: [...(old.privateNotes || []), note] } : old);
          if (note.recipientId === profile.id && activeIdRef.current !== event.conversationId) {
            playIncomingMessageTone();
            const chat = conversationsRef.current.find((item) => item.id === event.conversationId);
            setIncomingNotice({ isPrivateNote: true, conversationId: event.conversationId, customerName: note.author?.name || "زميل", channel: event.channel || chat?.channel, authorName: note.author?.name, preview: `رسالة سرية: ${note.text}` });
          }
        });
      connection.on("whatsapp:incoming-call", (call) => setIncomingCall(call));
      connection.on("whatsapp:call-ended", (event) => setIncomingCall((current) => current?.callId === event.callId ? null : current));
      connection.on("admin:viewing", (event) => setWatching(Boolean(event.viewing)));
      connection.on("sla:breached", () => setNotice("تنبيه: تجاوزت هذه المحادثة مهلة الرد المحددة."));
        const initialChatsRequest = ++chatLoadRequest.current;
        const handoffRequests = profile.role === "AGENT" ? api("/api/agents/handoff-requests") : Promise.resolve([]);
        const [chatPage, replies, catalog, favorites, customerFavorites, pins, requests, mutedConversations] = await Promise.all([api(`/api/conversations?${buildConversationListParams(50, undefined, false, false)}`), api("/api/canned-responses"), api("/api/products"), api("/api/conversations/favorites"), api("/api/customers/favorites"), api("/api/conversations/pins"), handoffRequests, api("/api/me/muted-conversations")]);
         if (!current) return;
         const chats = initialChatsRequest === chatLoadRequest.current ? chatPage.items || [] : conversationsRef.current;
          if (initialChatsRequest === chatLoadRequest.current && chatScopeRef.current === "OWN") {
            conversationsRef.current = chats; chatScopeRef.current = "OWN"; loadedExtraChatsRef.current = false;
           setConversations(chats); setChatCursor(chatPage.nextCursor || null); setHasMoreChats(Boolean(chatPage.hasMore)); setChatLoadError("");
         }
        setCanned(replies); setProducts(catalog); setFavoriteIds(favorites.map((item: AnyRecord) => item.id)); setPinnedIds(pins.map((item: AnyRecord) => item.id)); setFavoriteCustomerIds(customerFavorites.ids || []); setMutedConversationIds(mutedConversations.conversationIds || []); mutedConversationIdsRef.current = new Set(mutedConversations.conversationIds || []); setIncomingHandoffs((current) => [...requests, ...current.filter((item) => !requests.some((request: AnyRecord) => request.conversationId === item.conversationId))]);
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
          conversationsRef.current = conversationsRef.current.map((chat) => chat.id === id ? { ...chat, personalState: conversation.personalState, unreadCount: conversation.unreadCount } : chat);
          setConversations(conversationsRef.current);
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
    return () => {
      current = false;
      for (const timer of customerActivityTimersRef.current.values()) window.clearTimeout(timer);
      customerActivityTimersRef.current.clear();
      if (socketRef.current === connection) socketRef.current = null;
      connection?.disconnect();
    };
  }, [router]);

  useEffect(() => { setSoundEnabled(isNotificationSoundEnabled()); }, []);

  useEffect(() => {
    if (!user?.id) return;
    api<AnyRecord[]>("/api/agent/quick-replies").then(setAgentQuickReplies).catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    setPrivateNoteMode(false);
    setSecretNote("");
  }, [detail?.id]);

  useEffect(() => {
    const conversationId = detail?.id;
    const assignedAgentId = detail?.assignedAgentId || "";
    setPrivateNoteRecipients([]);
    setPrivateNoteRecipientId("");
    if (!conversationId || !detail.canSendPrivateNote) return;
    let current = true;
    void api<AnyRecord[]>(`/api/conversations/${conversationId}/private-note-recipients`).then((recipients) => {
      if (!current) return;
      setPrivateNoteRecipients(recipients);
      setPrivateNoteRecipientId(recipients.some((recipient) => recipient.id === assignedAgentId) ? assignedAgentId : "");
    }).catch((error) => {
      if (current) setNotice(error instanceof Error ? error.message : "تعذر تحميل الزملاء");
    });
    return () => { current = false; };
  }, [detail?.id, detail?.canSendPrivateNote, detail?.assignedAgentId]);

  useEffect(() => {
    if (!showContacts && !showContactCard) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setLoadingContacts(true);
      api<AnyRecord[]>(`/api/contacts?q=${encodeURIComponent(contactQuery)}`).then((result) => { if (current) setContactResults(result); })
        .catch((error) => { if (current) setNotice(error instanceof Error ? error.message : "تعذر تحميل جهات الاتصال"); })
        .finally(() => { if (current) setLoadingContacts(false); });
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [showContacts, showContactCard, contactQuery]);

  useEffect(() => {
    phoneSearchRequestRef.current += 1;
    setSearchingPhone(false);
    setPhoneSearchResult(null);
    setPhoneSearchError("");
  }, [search, filter, whatsappGroupFilter]);

  useEffect(() => {
    const query = search.trim();
    const digits = query.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/\D/g, "");
    const request = ++globalSearchRequestRef.current;
    if (query.length < 2 && digits.length < 3) {
      setGlobalSearchResults([]); setGlobalSearchHasMore(false); setGlobalSearchError(""); setGlobalSearchLoading(false);
      return;
    }
    setGlobalSearchResults([]); setGlobalSearchHasMore(false); setGlobalSearchError(""); setGlobalSearchLoading(true);
    const timer = window.setTimeout(() => {
      void api(`/api/conversations/search?${buildGlobalSearchParams(query)}`).then((page) => {
        if (request !== globalSearchRequestRef.current) return;
        setGlobalSearchResults(page.items || []); setGlobalSearchHasMore(Boolean(page.hasMore));
      }).catch((error) => {
        if (request === globalSearchRequestRef.current) setGlobalSearchError(error instanceof Error ? error.message : "تعذر البحث في المحادثات");
      }).finally(() => { if (request === globalSearchRequestRef.current) setGlobalSearchLoading(false); });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search, filter, whatsappGroupFilter]);

  useEffect(() => {
    const conversationId = detail?.id;
    const query = conversationSearchQuery.trim();
    const request = ++conversationSearchRequestRef.current;
    if (!showConversationSearch || !conversationId || query.length < 2) {
      setConversationSearchMatches([]); setConversationSearchTotal(0); setConversationSearchIndex(0); setConversationSearchLoading(false);
      return;
    }
    setConversationSearchLoading(true); setConversationSearchMatches([]); setConversationSearchTotal(0);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, conversationId });
      void api(`/api/conversations/search?${params}`).then((page) => {
        if (request !== conversationSearchRequestRef.current) return;
        const matches = page.items || [];
        setConversationSearchMatches(matches); setConversationSearchTotal(page.total || 0); setConversationSearchIndex(0);
        if (matches[0]?.id) void jumpToMessage(matches[0].id);
      }).catch((error) => {
        if (request === conversationSearchRequestRef.current) setNotice(error instanceof Error ? error.message : "تعذر البحث داخل المحادثة");
      }).finally(() => { if (request === conversationSearchRequestRef.current) setConversationSearchLoading(false); });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [showConversationSearch, conversationSearchQuery, detail?.id]);

  useEffect(() => {
    if (!showConversationSearch) return;
    conversationSearchInputRef.current?.focus();
  }, [showConversationSearch]);

  useEffect(() => {
    const pending = pendingMessageJumpRef.current;
    if (!pending || detail?.id !== pending.conversationId || !detail.messages?.some((message: AnyRecord) => message.id === pending.messageId)) return;
    pendingMessageJumpRef.current = null;
    requestAnimationFrame(() => {
      const element = document.getElementById(`message-${pending.messageId}`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      setShowJumpToBottom(false);
    });
  }, [detail?.id, detail?.messages?.length]);

  useEffect(() => {
    const saved = Number(localStorage.getItem("bondoq_chat_font_size"));
    if (Number.isFinite(saved) && saved >= 14 && saved <= 28) setChatFontSize(saved);
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.agent-app [role="dialog"][aria-modal="true"]'))
        .filter((dialog) => dialog.getClientRects().length > 0 && window.getComputedStyle(dialog).visibility !== "hidden");
      let topmostDialog: HTMLElement | null = null;
      let topmostLayer = -1;
      for (const dialog of dialogs) {
        let layer = 0;
        for (let element: HTMLElement | null = dialog; element; element = element.parentElement) {
          const style = window.getComputedStyle(element);
          if (style.position === "fixed" && style.zIndex !== "auto") { layer = Number(style.zIndex) || 0; break; }
        }
        if (layer > topmostLayer || layer === topmostLayer && topmostDialog && (topmostDialog.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          topmostDialog = dialog;
          topmostLayer = layer;
        }
      }
      if (topmostDialog) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const callCloseButton = topmostDialog.querySelector<HTMLButtonElement>('button[aria-label="إغلاق شاشة المكالمة"]');
        (callCloseButton || topmostDialog.querySelector<HTMLButtonElement>('button[aria-label^="إغلاق"], button[aria-label^="إلغاء"], button[aria-label^="إخفاء"], button[aria-label="تصغير نافذة المكالمة"]'))?.click();
        return;
      }
      if (openConversationMenuId) {
        event.preventDefault(); event.stopImmediatePropagation();
        setOpenConversationMenuId("");
        setListMenuConversationId("");
      } else if (showHeaderOptions) {
        event.preventDefault(); event.stopImmediatePropagation();
        setShowHeaderOptions(false);
        headerOptionsRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
      } else if (showEmojiPicker) {
        event.preventDefault(); event.stopImmediatePropagation();
        setShowEmojiPicker(false);
        emojiButtonRef.current?.focus();
      } else if (showStickerPicker) {
        event.preventDefault(); event.stopImmediatePropagation();
        setShowStickerPicker(false);
        plusButtonRef.current?.focus();
      } else if (showPlusMenu) {
        event.preventDefault(); event.stopImmediatePropagation();
        setShowPlusMenu(false);
        plusButtonRef.current?.focus();
      } else if (showCanned) {
        event.preventDefault(); event.stopImmediatePropagation();
        setShowCanned(false);
        replyInputRef.current?.focus();
      } else {
        const openDetails = document.querySelector<HTMLDetailsElement>(".workspace-chat details[open]");
        if (openDetails) {
          event.preventDefault(); event.stopImmediatePropagation();
          openDetails.open = false;
          openDetails.querySelector("summary")?.focus();
        } else if (showMobileProfile || showCustomerSidebar) {
          event.preventDefault(); event.stopImmediatePropagation();
          setShowMobileProfile(false);
          setShowCustomerSidebar(false);
        } else if (activeIdRef.current) {
          event.preventDefault(); event.stopImmediatePropagation();
          returnToChatList();
        }
      }
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [openConversationMenuId, showHeaderOptions, showEmojiPicker, showStickerPicker, showPlusMenu, showCanned, showMobileProfile, showCustomerSidebar, returnToChatList]);

  useEffect(() => {
    if (!openConversationMenuId) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !conversationMenuRef.current?.contains(event.target)) {
        setOpenConversationMenuId("");
        setListMenuConversationId("");
      }
    };
    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
    };
  }, [openConversationMenuId]);

  useEffect(() => {
    if (!showHeaderOptions) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !headerOptionsRef.current?.contains(event.target)) setShowHeaderOptions(false);
    };
    const handleMenuKeys = (event: KeyboardEvent) => {
      const items = Array.from(headerOptionsRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
      if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current <= 0 ? items.length : current) - 1;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    document.addEventListener("keydown", handleMenuKeys);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
      document.removeEventListener("keydown", handleMenuKeys);
    };
  }, [showHeaderOptions]);

  useEffect(() => {
    if (!showPlusMenu) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !plusMenuRef.current?.contains(event.target) && !plusButtonRef.current?.contains(event.target)) setShowPlusMenu(false);
    };
    const handleMenuKeys = (event: KeyboardEvent) => {
      const items = Array.from(plusMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
      if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current <= 0 ? items.length : current) - 1;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    document.addEventListener("keydown", handleMenuKeys);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
      document.removeEventListener("keydown", handleMenuKeys);
    };
  }, [showPlusMenu]);

  useEffect(() => {
    if (!showStickerPicker) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !stickerPickerRef.current?.contains(event.target)) setShowStickerPicker(false);
    };
    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
    };
  }, [showStickerPicker]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !emojiPickerRef.current?.contains(event.target) && !emojiButtonRef.current?.contains(event.target)) setShowEmojiPicker(false);
    };
    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
    };
  }, [showEmojiPicker]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    const previewUrl = failedRecording?.previewUrl;
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [failedRecording?.previewUrl]);

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

  useEffect(() => { setCustomerActivity(""); }, [activeId]);

  useEffect(() => {
    if (!detail || !messageEndRef.current) return;
    if (stickToBottom.current) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      setShowJumpToBottom(false);
    } else setShowJumpToBottom(true);
  }, [detail?.id, detail?.messages?.length]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    void api<AnyRecord[]>("/api/me/starred-messages").then((items) => { if (active) setStarredMessages(items); }).catch(() => {});
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    if (!notice || notice.startsWith("جارٍ")) return;
    const timer = window.setTimeout(() => setNotice((current) => current === notice ? "" : current), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (statusFilter !== "TEAM") return;
    const timer = window.setInterval(() => void loadChats(false, true), 20_000);
    return () => window.clearInterval(timer);
  }, [statusFilter]);

  useEffect(() => {
    if (!showProducts) return;
    api("/api/products").then(setProducts).catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تحديث كتالوج المنتجات"));
  }, [showProducts]);

  const latestInbound = [...(detail?.messages || [])].reverse().find((message: AnyRecord) => message.direction === "INBOUND");
  const privateNotePresenceLabels: Record<string, string> = { ONLINE: "متصل", BUSY: "مشغول", BREAK: "استراحة", OFFLINE: "غير متصل" };
  const displayedMessages = (detail?.messages || []).filter((message: AnyRecord) => messageFilter === "ALL"
    || messageFilter === "IMAGES" && ["IMAGE", "STICKER"].includes(message.kind)
    || messageFilter === "AUDIO" && message.kind === "AUDIO"
    || messageFilter === "VIDEO" && message.kind === "VIDEO"
    || messageFilter === "FILES" && message.kind === "FILE"
    || messageFilter === "LINKS" && hasMessageTextLinks(message.text)).map((message: AnyRecord) => ({
      ...message,
      isStarred: starredMessages.some((item) => item.id === message.id),
      onToggleStar: () => void toggleMessageStar(message)
    }));
  const selectedMessages = (detail?.messages || []).filter((message: AnyRecord) => selectedMessageIds.includes(message.id));
  const localStickerMessages = [...(detail?.messages || [])].reverse().filter((message: AnyRecord) => message.kind === "STICKER" && message.mediaAssetId && message.mediaAsset?.contentType === "image/webp");
  const starredStickerMessages = starredMessages.filter((item) => item.message?.kind === "STICKER").map((item) => ({ ...item.message, conversationId: item.conversationId }));
  const savedStickers = [...starredStickerMessages, ...localStickerMessages].filter((message: AnyRecord, index: number, messages: AnyRecord[]) => messages.findIndex((item: AnyRecord) => item.mediaAssetId === message.mediaAssetId) === index).slice(0, 12);
  const deletableSelectedMessages = selectedMessages.filter((message: AnyRecord) => message.direction === "OUTBOUND" && message.authorId === user?.id && message.externalId && ["SENT", "DELIVERED", "READ", "PLAYED"].includes(message.deliveryStatus));
  const forwardableSelectedMessages = selectedMessages.filter((message: AnyRecord) => message.kind !== "SYSTEM" && message.direction !== "INTERNAL" && !String(message.id).startsWith("pending-") && (message.kind !== "LOCATION" || message.latitude != null && message.longitude != null));
  const lastInboundAt = detail?.lastInboundAt || latestInbound?.createdAt;
  const metaChannel = detail?.channel === "MESSENGER";
  const callTarget = isWhatsAppGroupConversation(detail) ? "" : detail?.customer?.phone || detail?.externalCustomerId || "";
  const windowRemaining = lastInboundAt ? new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000 - now : 0;
  const metaWindowOpen = !metaChannel || windowRemaining > 0;
  const messagingEnabled = metaWindowOpen && !detail?.customer?.isBlocked;
  const expiringSoon = metaChannel && metaWindowOpen && windowRemaining < 2 * 60 * 60 * 1000;

  async function changePresence(next: string) {
    try {
      const response = await api("/api/agents/me/presence", { method: "PATCH", body: JSON.stringify({ presence: next }) });
      presenceRef.current = response.presence;
      setPresence(response.presence);
      if (response.presence === "OFFLINE") {
        activeIdRef.current = ""; setActiveId(""); setDetail(null); await loadChats();
      }
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الحالة"); }
  }
  async function deliverReply(payload: { text?: string; kind?: string; mediaAssetId?: string; applyTagIds?: string[]; previewUrl?: string; latitude?: number; longitude?: number; quotedMessageId?: string; draftRevision?: number }, conversationId = activeId, alreadyLocked = false, pendingId?: string): Promise<boolean> {
    const removePending = () => {
      if (pendingId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => item.id !== pendingId) } : old);
    };
    const restoreDraft = () => {
      if (payload.text !== undefined && payload.draftRevision === replyDraftRevisionRef.current) setTextState((current) => current || payload.text || "");
    };
    const discardPending = () => { removePending(); if (payload.previewUrl) URL.revokeObjectURL(payload.previewUrl); };
    if (!conversationId) { if (alreadyLocked) { sendingRef.current = false; setSending(false); } discardPending(); restoreDraft(); return false; }
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); if (alreadyLocked) { sendingRef.current = false; setSending(false); } discardPending(); restoreDraft(); return false; }
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل الرد."); if (alreadyLocked) { sendingRef.current = false; setSending(false); } discardPending(); restoreDraft(); return false; }
    if (!alreadyLocked && sendingRef.current) { discardPending(); restoreDraft(); return false; }
    if (!alreadyLocked) { sendingRef.current = true; setSending(true); }
    const localId = pendingId || `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMessage = { id: localId, conversationId, author: { name: user?.name || "أنت" }, createdAt: new Date().toISOString(), direction: "OUTBOUND", kind: payload.kind || "TEXT", text: payload.text, mediaAssetId: payload.mediaAssetId, latitude: payload.latitude, longitude: payload.longitude, quotedMessageId: payload.quotedMessageId, localPreviewUrl: payload.previewUrl, deliveryStatus: "PENDING" };
    if (!pendingId) setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], pendingMessage) } : old);
    activeOutgoingClientIdsRef.current.add(localId);
    if (payload.text !== undefined && payload.draftRevision === replyDraftRevisionRef.current) setTextState("");
    setShowCanned(false); setNotice("");
    try {
      const message = await api(`/api/conversations/${conversationId}/reply`, { method: "POST", body: JSON.stringify({ text: payload.text, kind: payload.kind || "TEXT", mediaAssetId: payload.mediaAssetId, applyTagIds: payload.applyTagIds, latitude: payload.latitude, longitude: payload.longitude, quotedMessageId: payload.quotedMessageId, clientMessageId: localId }) });
      const correlatedMessageId = pendingServerMessageIdsRef.current.get(localId);
      pendingServerMessageIdsRef.current.delete(localId);
      activeOutgoingClientIdsRef.current.delete(localId);
      setDetail((old: AnyRecord) => {
        if (old?.id !== conversationId) return old;
        const currentMessage = correlatedMessageId ? (old.messages || []).find((item: AnyRecord) => item.id === correlatedMessageId) : null;
        const currentIsFinal = ["SENT", "DELIVERED", "READ", "PLAYED", "FAILED"].includes(currentMessage?.deliveryStatus);
        const settledMessage = currentIsFinal ? { ...currentMessage, localPreviewUrl: undefined } : message;
        const removedIds = new Set([localId, message.id, ...(correlatedMessageId ? [correlatedMessageId] : [])]);
        return { ...old, messages: mergeMessages((old.messages || []).filter((item: AnyRecord) => !removedIds.has(item.id)), settledMessage) };
      });
      if (payload.quotedMessageId) setReplyingTo((old) => old?.id === payload.quotedMessageId ? null : old);
      if (message.deliveryStatus === "FAILED") { setNotice("تعذر إضافة الرسالة إلى قائمة الإرسال. تحقق من اتصال WhatsApp."); restoreDraft(); }
      else if (message.quickReplyTagsApplied === false) setNotice("تم إرسال الرد، لكن تعذرت إضافة القوائم للعميل.");
      void loadChats();
      return message.deliveryStatus !== "FAILED";
    } catch (error) {
      const serverMessageId = pendingServerMessageIdsRef.current.get(localId);
      pendingServerMessageIdsRef.current.delete(localId);
      activeOutgoingClientIdsRef.current.delete(localId);
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => item.id !== localId).map((item: AnyRecord) => item.id === serverMessageId ? { ...item, localPreviewUrl: undefined } : item) } : old);
      if (!serverMessageId) restoreDraft();
      setNotice(error instanceof Error ? error.message : "تعذر إرسال الرد. تحقق من إعداد ربط القناة.");
      return false;
    } finally {
      sendingRef.current = false; setSending(false);
      if (payload.previewUrl) URL.revokeObjectURL(payload.previewUrl);
    }
  }
  async function submitReply() {
    const message = text.trim();
    const quickReply = pendingQuickReply;
    if (!message && !quickReply?.mediaAssetId) return;
    const contentType = String(quickReply?.mediaAsset?.contentType || "");
    const kind = !quickReply?.mediaAssetId ? "TEXT" : contentType.startsWith("image/") ? "IMAGE" : contentType.startsWith("audio/") ? "AUDIO" : contentType.startsWith("video/") ? "VIDEO" : "FILE";
    const sent = await deliverReply({ text: message || undefined, kind, mediaAssetId: quickReply?.mediaAssetId, applyTagIds: quickReply?.tagIds, quotedMessageId: replyingTo?.id, draftRevision: replyDraftRevisionRef.current });
    if (sent) setPendingQuickReply(null);
  }
  function recallLastSentMessage() {
    const message = latestOutgoingTextMessage(detail?.messages || [], user?.id);
    if (!message) return false;
    setText(message.text);
    setShowCanned(false);
    requestAnimationFrame(() => replyInputRef.current?.focus());
    return true;
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
  function keepFailedRecording(file: File, conversationId: string) {
    if (file.size) setFailedRecording({ file, previewUrl: URL.createObjectURL(file), conversationId });
  }
  function retryFailedRecording() {
    const failed = failedRecording;
    if (!failed || failed.conversationId !== activeId) return;
    setFailedRecording(null);
    void uploadAndSend(failed.file, true, failed.conversationId);
  }
  async function uploadAndSend(file: File, preserveRecording = false, targetConversationId = activeId) {
    const conversationId = targetConversationId;
    const draftRevision = replyDraftRevisionRef.current;
    const keepRecording = () => { if (preserveRecording) keepFailedRecording(file, conversationId); };
    if (!conversationId) { keepRecording(); return; }
    if (detail?.readOnly) { setNotice("هذه المحادثة للقراءة فقط."); keepRecording(); return; }
    if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); keepRecording(); return; }
    if (!metaWindowOpen) { setNotice("انتهت نافذة رد Messenger. انتظر رسالة جديدة من العميل قبل إرسال الملف."); keepRecording(); return; }
    if (sendingRef.current) { setNotice("انتظر انتهاء الإرسال الحالي قبل إرسال التسجيل."); keepRecording(); return; }
    if (!file.size) { setNotice("التسجيل فارغ. سجّل رسالة صوتية أطول ثم أرسلها."); return; }
    if (file.size > 12 * 1024 * 1024) { setNotice("حجم الملف الأقصى 12 ميجابايت."); keepRecording(); return; }
     const extensionType: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: file.type.startsWith("audio/") ? "audio/webm" : "application/octet-stream", aac: "audio/aac", mp4: "video/mp4", "3gp": "video/3gpp", mov: "video/quicktime", pdf: "application/pdf", txt: "text/plain", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const contentType = (file.type || extensionType[extension] || "").split(";")[0].toLowerCase();
      const kind = contentType === "image/webp" ? "STICKER" : contentType.startsWith("image/") ? "IMAGE" : contentType.startsWith("audio/") ? "AUDIO" : contentType.startsWith("video/") ? "VIDEO" : "FILE";
      const previewUrl = ["IMAGE", "STICKER", "AUDIO", "VIDEO"].includes(kind) ? URL.createObjectURL(file) : undefined;
     const caption = kind === "STICKER" ? undefined : text.trim() || undefined;
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMessage = { id: pendingId, conversationId, author: { name: user?.name || "أنت" }, createdAt: new Date().toISOString(), direction: "OUTBOUND", kind, text: caption, localPreviewUrl: previewUrl, deliveryStatus: "UPLOADING" };
    sendingRef.current = true; setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: mergeMessages(old.messages || [], pendingMessage) } : old); setNotice("جارٍ رفع الملف..."); setSending(true);
    if (caption !== undefined && draftRevision === replyDraftRevisionRef.current) setTextState("");
    try {
      const response = await fetch(`${API_URL}/api/media`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": contentType || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Conversation-Id": conversationId }, body: file });
      const uploaded = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(uploaded.error || `تعذر رفع الملف (${response.status})`);
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).map((item: AnyRecord) => item.id === pendingId ? { ...item, deliveryStatus: "PENDING" } : item) } : old);
      setNotice("");
      const sent = await deliverReply({ text: caption, kind, mediaAssetId: uploaded.id, previewUrl, draftRevision }, conversationId, true, pendingId);
      if (preserveRecording) {
        if (sent) setFailedRecording(null);
        else keepRecording();
      }
    } catch (error) {
      sendingRef.current = false; setSending(false);
      setDetail((old: AnyRecord) => old?.id === conversationId ? { ...old, messages: (old.messages || []).filter((item: AnyRecord) => item.id !== pendingId) } : old);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (caption !== undefined && draftRevision === replyDraftRevisionRef.current) setTextState((current) => current || caption);
      keepRecording();
      setNotice(error instanceof Error ? error.message : "تعذر رفع الملف أو إرساله");
    }
  }
  async function uploadSelectedFiles(files: File[]) {
    for (const file of files) {
      const isImage = file.type.startsWith("image/") || /\.(?:jpe?g|png|webp)$/i.test(file.name);
      const prepared = isImage ? await editImageBeforeSend(file) : file;
      if (prepared) await uploadAndSend(prepared);
    }
  }
  async function sendSavedSticker(message: AnyRecord) {
    if (!message.mediaAssetId || message.mediaAsset?.contentType !== "image/webp") return;
    if (await deliverReply({ kind: "STICKER", mediaAssetId: message.mediaAssetId })) setShowStickerPicker(false);
  }
  function editImageBeforeSend(file: File): Promise<File | null> {
    return new Promise((resolve) => {
      imageEditorResolverRef.current = resolve;
      setImageEditor({ file, url: URL.createObjectURL(file) });
    });
  }
  function finishImageEditor(file: File | null) {
    const editor = imageEditor;
    const resolve = imageEditorResolverRef.current;
    if (!editor || !resolve) return;
    imageEditorResolverRef.current = null;
    setImageEditor(null);
    URL.revokeObjectURL(editor.url);
    resolve(file);
  }
    function sendAgentWhatsAppPresence(conversationId: string, activity: "composing" | "recording" | "paused") {
      const currentActivity = agentPresenceRef.current;
      if (activity !== "paused") {
        const conversation = detail?.id === conversationId ? detail : conversationsRef.current.find((item) => item.id === conversationId);
        if (conversation?.channel !== "WHATSAPP" || conversation.readOnly || privateNoteMode) return;
      }
      if (activity === "paused" && (currentActivity.conversationId !== conversationId || currentActivity.activity === "paused")) return;
      const now = Date.now();
      const shouldSend = activity === "paused" || currentActivity.conversationId !== conversationId || currentActivity.activity !== activity || now - currentActivity.sentAt >= 2500;
      agentPresenceRef.current = { conversationId, activity, sentAt: shouldSend ? now : currentActivity.sentAt };
      if (shouldSend) {
        void api(`/api/conversations/${conversationId}/whatsapp-presence`, { method: "POST", body: JSON.stringify({ activity }) }).catch(() => {
          if (agentPresenceRef.current.conversationId === conversationId && agentPresenceRef.current.activity === activity) agentPresenceRef.current.sentAt = 0;
        });
      }
      if (agentPresenceTimerRef.current) clearTimeout(agentPresenceTimerRef.current);
      agentPresenceTimerRef.current = activity === "composing" ? setTimeout(() => sendAgentWhatsAppPresence(conversationId, "paused"), 3000) : null;
    }

     async function startRecording() {
      const conversationId = activeId;
      if (recorderRef.current || recordingStartRef.current || !conversationId || sendingRef.current) return;
      if (failedRecording?.conversationId === conversationId) { setNotice("أعد إرسال التسجيل المحفوظ أو أزله قبل بدء تسجيل جديد."); return; }
      if (detail?.customer?.isBlocked) { setNotice("هذا العميل محظور داخل النظام. ألغِ الحظر قبل إرسال أي رسالة."); return; }
      recordingStartRef.current = true;
      setRequestingRecording(true);
      let stream: MediaStream | undefined;
      let recorder: MediaRecorder | undefined;
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream = audioStream;
        if (activeIdRef.current !== conversationId) {
          stream.getTracks().forEach((track) => track.stop());
          setNotice("تغيّرت المحادثة قبل بدء التسجيل؛ ابدأ التسجيل مجددًا.");
          return;
        }
        const supported = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/ogg", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
        const createdRecorder = new MediaRecorder(audioStream, supported ? { mimeType: supported } : undefined);
        recorder = createdRecorder;
        const chunks: Blob[] = [];
        createdRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
         createdRecorder.onstop = () => {
          sendAgentWhatsAppPresence(conversationId, "paused");
          audioStream.getTracks().forEach((track) => track.stop()); recorderRef.current = null; setRecording(false);
          setRecordingSeconds(0);
          if (recordingCancelledRef.current) { recordingCancelledRef.current = false; return; }
          const blob = new Blob(chunks, { type: createdRecorder.mimeType || "audio/webm" });
          const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
          void uploadAndSend(new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type }), true, conversationId);
        };
        recordingCancelledRef.current = false; recordingStartedAtRef.current = Date.now(); recorderRef.current = createdRecorder; createdRecorder.start(); sendAgentWhatsAppPresence(conversationId, "recording"); setRecording(true); setRecordingSeconds(0); setNotice("التسجيل جارٍ. أرسل التسجيل أو ألغِه عند الانتهاء.");
      } catch {
        sendAgentWhatsAppPresence(conversationId, "paused");
        if (recorderRef.current === recorder) recorderRef.current = null;
        stream?.getTracks().forEach((track) => track.stop());
        setNotice("تعذر بدء التسجيل. تحقق من إذن استخدام الميكروفون في المتصفح.");
      } finally { recordingStartRef.current = false; setRequestingRecording(false); }
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
      const payload = { ...order, price: order.price ? Number(order.price) : undefined, deposit: order.deposit ? Number(order.deposit) : 0, deliveryAt: cairoInputToIso(order.deliveryAt) };
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
  function openCustomerProfile() {
    setShowCustomerSidebar(true);
    setShowMobileProfile(true);
  }
  function closeCustomerProfile() {
    setShowCustomerSidebar(false);
    setShowMobileProfile(false);
  }
  async function deferConversation() {
    if (!activeId) return;
    try {
      await api(`/api/conversations/${activeId}/status`, { method: "PATCH", body: JSON.stringify({ status: "PENDING" }) });
      setNotice("تم تأجيل المحادثة للمتابعة لاحقًا.");
      void loadChats();
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تأجيل المحادثة"); }
  }
  function returnToChatList() {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    ++detailRequest.current;
    detailLoadingIdRef.current = "";
    loadingMessagesRef.current.delete(conversationId);
    socketRef.current?.emit("conversation:leave", conversationId);
    activeIdRef.current = "";
    setCustomerActivity("");
    setActiveId("");
    setDetail(null);
    setIncomingNotice(null);
    setShowMobileProfile(false);
    setShowCustomerSidebar(false);
    setShowConversationSidebar(true);
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

  const hasGlobalSearchQuery = search.trim().length >= 2 || search.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/\D/g, "").length >= 3;
  const visible = conversations.filter((chat) => {
    const statusMatches = statusFilter === "TEAM" || (statusFilter === "HISTORY" ? Boolean(chat.readOnly) : statusFilter === "ALL" || (statusFilter === "FAVORITES" ? favoriteIds.includes(chat.id) : statusFilter === "PINNED" ? pinnedIds.includes(chat.id) : statusFilter === "ARCHIVED" ? Boolean(chat.personalState?.isArchived) : statusFilter === "ACTIVE" ? ["OPEN", "PENDING", "QUEUED"].includes(chat.status) : chat.status === statusFilter));
    const groupMatches = whatsappGroupFilter === "ALL" || (whatsappGroupFilter === "GROUPS" ? isWhatsAppGroupConversation(chat) : !isWhatsAppGroupConversation(chat));
    return statusMatches && (filter === "ALL" || chat.channel === filter) && groupMatches && (!search.trim() || hasGlobalSearchQuery || `${customerDisplayName(chat.customer)} ${chat.customer?.phone || ""} ${chat.messages?.[0]?.text || ""}`.toLowerCase().includes(search.toLowerCase()));
  }).sort((left, right) => Number(isWaitingForAgent(right)) - Number(isWaitingForAgent(left)) || Number(Boolean(right.unreadCount)) - Number(Boolean(left.unreadCount)) || Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
  const availableChannels = user
    ? channels.filter((item) => {
      if (item.id === "ALL") return true;
      const access = item.id === "WHATSAPP" ? user.whatsappAccess : item.id === "MESSENGER" ? user.messengerAccess : user.telegramAccess;
      if (access) return access !== "DISABLED";
      if (item.id === "WHATSAPP") return user.canReceiveWhatsApp !== false;
      if (item.id === "MESSENGER") return user.canReceiveMessenger !== false;
      if (item.id === "TELEGRAM") return user.canReceiveTelegram !== false;
      return false;
    })
    : channels.filter((item) => item.id === "ALL");
  const filteredCanned = [...agentQuickReplies, ...canned].filter((item) => !text.startsWith("/") || item.shortcut.toLowerCase().includes(text.toLowerCase()) || item.title.includes(text.slice(1)));
  const visibleProducts = products.filter((product) => (productFilter === "ALL" || product.category === productFilter) && `${product.name || ""} ${product.sku || ""}`.toLocaleLowerCase().includes(productSearch.trim().toLocaleLowerCase()));
  const workspaceColumns = `${showConversationSidebar ? "var(--conversation-sidebar-width) 8px " : ""}minmax(0,1fr)${showCustomerSidebar ? " 300px" : ""}`;

  useEffect(() => {
    try {
      const savedWidth = Number(window.localStorage.getItem(CONVERSATION_SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(savedWidth) && savedWidth > 0) setConversationSidebarWidth(clampConversationSidebarWidth(savedWidth));
    } catch {}
    setConversationSidebarWidthLoaded(true);
  }, []);

  useEffect(() => {
    if (!conversationSidebarWidthLoaded) return;
    try { window.localStorage.setItem(CONVERSATION_SIDEBAR_WIDTH_KEY, String(conversationSidebarWidth)); } catch {}
  }, [conversationSidebarWidth, conversationSidebarWidthLoaded]);

  function startConversationSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeStartRef.current = { x: event.clientX, width: conversationSidebarWidth };
    sidebarWidthDraftRef.current = conversationSidebarWidth;
    setResizingConversationSidebar(true);
  }

  function moveConversationSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidebarResizeStartRef.current;
    if (!start) return;
    const width = clampConversationSidebarWidth(start.width + event.clientX - start.x);
    sidebarWidthDraftRef.current = width;
    workspaceGridRef.current?.style.setProperty("--conversation-sidebar-width", `${width}px`);
  }

  function endConversationSidebarResize() {
    if (!sidebarResizeStartRef.current) return;
    sidebarResizeStartRef.current = null;
    setResizingConversationSidebar(false);
    setConversationSidebarWidth(sidebarWidthDraftRef.current);
  }

  useEffect(() => { setCannedReplyIndex(0); }, [showCanned, text, agentQuickReplies, canned]);

  useEffect(() => {
    const current = agentPresenceRef.current;
    if (current.conversationId && current.conversationId !== activeId && current.activity !== "paused") sendAgentWhatsAppPresence(current.conversationId, "paused");
    const canShowTyping = Boolean(activeId && detail?.id === activeId && detail.channel === "WHATSAPP" && !detail.readOnly && !privateNoteMode && text.trim());
    if (canShowTyping) sendAgentWhatsAppPresence(activeId, "composing");
    else if (agentPresenceRef.current.activity === "composing") sendAgentWhatsAppPresence(agentPresenceRef.current.conversationId, "paused");
  }, [activeId, detail?.id, detail?.channel, detail?.readOnly, privateNoteMode, text]);

  useEffect(() => () => {
    if (agentPresenceTimerRef.current) clearTimeout(agentPresenceTimerRef.current);
    const current = agentPresenceRef.current;
    if (current.conversationId && current.activity !== "paused") {
      void api(`/api/conversations/${current.conversationId}/whatsapp-presence`, { method: "POST", body: JSON.stringify({ activity: "paused" }) }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const input = replyInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [text, secretNote, privateNoteMode]);

  function chooseCannedReply(reply: AnyRecord) {
    setText(reply.content);
    setPendingQuickReply({ shortcut: reply.shortcut, mediaAsset: reply.mediaAsset || null, mediaAssetId: reply.mediaAsset?.id || null, tagIds: (reply.tags || []).map((item: AnyRecord) => item.tagId || item.tag?.id).filter(Boolean) });
    setShowCanned(false);
    requestAnimationFrame(() => replyInputRef.current?.focus());
  }

  useEffect(() => {
    const handleQuickReplyKeys = (event: KeyboardEvent) => {
      if (document.activeElement !== replyInputRef.current) return;
      if (showCanned && ["ArrowDown", "ArrowUp"].includes(event.key) && filteredCanned.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setCannedReplyIndex((current) => event.key === "ArrowDown" ? (current + 1) % filteredCanned.length : (current - 1 + filteredCanned.length) % filteredCanned.length);
      } else if (showCanned && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (filteredCanned[cannedReplyIndex]) chooseCannedReply(filteredCanned[cannedReplyIndex]);
      }
    };
    document.addEventListener("keydown", handleQuickReplyKeys, true);
    return () => document.removeEventListener("keydown", handleQuickReplyKeys, true);
  }, [showCanned, cannedReplyIndex, filteredCanned]);

  return <main style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties} className={`agent-app h-screen min-h-[700px] overflow-hidden bg-[#f0f2f5] text-stone-800 ${resizingConversationSidebar ? "is-resizing-sidebar" : ""}`}>
    <header className="flex h-[68px] items-center justify-between border-b border-stone-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#d32f2f] text-lg font-black text-[#ffc107]">ب</div><div><b className="text-sm">حلواني بندق</b><p className="text-[10px] text-stone-400">مساحة العمل · محادثاتك المخصصة</p></div></div>
      <div className="flex items-center gap-1 sm:gap-2"><span className="hidden text-xs font-bold text-stone-600 sm:inline">حالتك</span><div className="relative"><select value={presence} onChange={(e) => changePresence(e.target.value)} className={`h-9 appearance-none rounded-full pl-8 pr-3 text-xs font-bold outline-none ${presence === "ONLINE" ? "bg-emerald-50 text-emerald-700" : presence === "OFFLINE" ? "bg-stone-100 text-stone-500" : "bg-amber-50 text-amber-800"}`}><option value="ONLINE">متاح</option><option value="BUSY">مشغول</option><option value="BREAK">استراحة</option><option value="OFFLINE">غير متصل</option></select><span className={`absolute left-2.5 top-3 h-2 w-2 rounded-full ${presence === "ONLINE" ? "bg-emerald-500" : presence === "OFFLINE" ? "bg-stone-400" : "bg-amber-500"}`} /></div><PushNotificationsButton /><InstallAppButton /><button type="button" onClick={() => router.push("/contacts")} title="جهات الاتصال ودليل الشركة" aria-label="جهات الاتصال ودليل الشركة" className="grid h-9 w-9 place-items-center rounded-lg text-stone-500 hover:bg-amber-50 hover:text-amber-700"><BookUser size={17} /></button><button type="button" aria-label={soundEnabled ? "إيقاف صوت الرسائل" : "تشغيل صوت الرسائل"} title={soundEnabled ? "إيقاف صوت الرسائل الجديدة" : "تشغيل صوت الرسائل الجديدة"} onClick={() => { const next = !soundEnabled; setSoundEnabled(next); setNotificationSoundEnabled(next); }} className={`grid h-9 w-9 place-items-center rounded-lg ${soundEnabled ? "text-emerald-700 hover:bg-emerald-50" : "text-stone-400 hover:bg-stone-100"}`}>{soundEnabled ? <Bell size={17} /> : <BellOff size={17} />}</button><div className="mr-2 hidden h-8 w-px bg-stone-200 sm:block" /><div className="hidden text-left sm:block"><b className="block text-xs">{user?.name || "الموظف"}</b><span className="text-[10px] text-stone-400">{department(user?.department)}</span></div><Avatar name={user?.name || "م"} /><button onClick={() => setShowAccount(true)} className="rounded-lg p-2 text-stone-400 hover:bg-amber-50 hover:text-amber-700" title="إعدادات الحساب"><UserRound size={17} /></button><button onClick={logout} className="mr-1 rounded-lg px-2 py-2 text-xs text-stone-400 hover:bg-stone-100" title="تسجيل الخروج"><ArrowLeft size={17} /></button></div>
    </header>

      {incomingHandoffs.length > 0 && <div className="fixed left-3 right-3 top-[76px] z-[60] ml-auto max-h-[60vh] max-w-sm space-y-2 overflow-y-auto sm:left-auto sm:right-6">{incomingHandoffs.slice(0, 4).map((request) => <article key={request.conversationId} role="status" className="rounded-2xl border border-amber-200 bg-white p-4 shadow-xl"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-extrabold text-amber-900">طلب استلام محادثة</p><p className="mt-1 truncate text-xs font-bold text-stone-700">{request.conversation?.customer?.displayName || request.conversation?.customer?.name || "عميل"}</p><p className="mt-1 text-[10px] text-stone-500">حوّلها إليك {request.fromAgent?.name || "زميل"}. اقبل لتصبح مسؤولًا عنها أو ارفض لتبقى لدى زميلك.</p></div><button type="button" onClick={() => setIncomingHandoffs((current) => current.filter((item) => item.conversationId !== request.conversationId))} aria-label="إخفاء طلب التحويل" className="rounded-md p-1 text-stone-400 hover:bg-stone-100">×</button></div>{handoffError && handoffError.conversationId === request.conversationId && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700">{handoffError.message}</p>}<div className="mt-3 flex gap-2"><button type="button" disabled={Boolean(handoffResponseBusyId)} onClick={() => void respondToHandoff(request, "DECLINE")} className="min-h-10 flex-1 rounded-lg border border-stone-200 px-3 text-xs font-bold text-stone-600 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50">{handoffResponseBusyId === request.conversationId && handoffResponseDecision === "DECLINE" ? "جارٍ الرفض..." : "رفض"}</button><button type="button" disabled={Boolean(handoffResponseBusyId)} onClick={() => void respondToHandoff(request, "ACCEPT")} className="min-h-10 flex-1 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">{handoffResponseBusyId === request.conversationId && handoffResponseDecision === "ACCEPT" ? "جارٍ القبول..." : "قبول واستلام"}</button></div></article>)}</div>}
       {incomingNotice && <div role="status" aria-live="polite" className="fixed left-3 right-3 top-[76px] z-50 ml-auto flex max-w-sm items-center gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-xl sm:left-auto sm:right-6"><div className="min-w-0 flex-1"><p className="text-xs font-extrabold text-emerald-900">{incomingNotice.isAutoReassignment ? "محادثة أُعيد إسنادها إليك" : incomingNotice.isAdminReassignment ? "تم سحب المحادثة بواسطة الإدارة" : incomingNotice.isHandoffSent ? "تم تحويل المحادثة" : incomingNotice.isHandoff ? "محادثة محولة إليك" : `رسالة جديدة من ${incomingNotice.customerName}`}</p><p className="mt-1 text-[10px] text-stone-400">{incomingNotice.channel ? channelName(incomingNotice.channel) : "إشعار من المدير"}</p><p className="mt-1 line-clamp-2 text-xs text-stone-600">{incomingNotice.preview}</p></div>{!incomingNotice.isHandoffSent && <button type="button" onClick={() => { const id = incomingNotice.conversationId; setIncomingNotice(null); void openChat(id); }} className="shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-[10px] font-bold text-white">عرض المحادثة</button>}<button type="button" onClick={() => setIncomingNotice(null)} aria-label="إغلاق التنبيه" className="shrink-0 rounded-lg p-1 text-stone-400 hover:bg-stone-100">×</button></div>}

      <section ref={workspaceGridRef} data-chat-open={Boolean(activeId)} style={{ gridTemplateColumns: workspaceColumns, "--conversation-sidebar-width": `${conversationSidebarWidth}px` } as CSSProperties} className="workspace-grid grid h-[calc(100vh-68px)] min-h-[632px] grid-cols-[285px_minmax(0,1fr)_300px] gap-3 p-3 sm:gap-4 sm:p-4">
       <input ref={photoInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void uploadSelectedFiles(files); }} />
       <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void uploadSelectedFiles(files); }} />
        <aside id="conversation-list" className={`workspace-list panel flex min-h-0 flex-col overflow-hidden ${showConversationSidebar ? "" : "workspace-list-collapsed"}`}>
              <div className="px-4 pt-4"><div className="mb-3 flex items-center justify-between gap-2"><div><h1 className="font-extrabold">المحادثات</h1><p className="text-[10px] text-stone-400">{statusFilter === "STARRED" ? `${starredMessages.length} رسالة مميزة` : statusFilter === "TEAM" ? `${conversations.length} محادثة لدى الفريق` : statusFilter === "HISTORY" ? `${conversations.length} محادثة في سجلك` : `${conversations.length} محادثة مسندة إليك`}</p></div><button type="button" onClick={() => { setContactQuery(""); setShowContacts(true); }} title="بدء محادثة جديدة من جهات الاتصال" aria-label="جهات الاتصال وبدء محادثة جديدة" className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#e7f5ed] px-2 text-[10px] font-bold text-[#187a4a] hover:bg-[#d6eddf]"><Users size={14} /> جهات الاتصال</button><span className="grid h-8 min-w-8 place-items-center rounded-full bg-red-50 px-2 text-xs font-bold text-[#d32f2f]">{conversations.filter((c) => c.unreadCount).length}</span></div><label className="flex h-10 items-center gap-2 rounded-xl bg-[#f7f5f1] px-3"><Search size={15} className="text-stone-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم أو الهاتف أو نص الرسالة" className="w-full bg-transparent text-xs outline-none" /></label>
              {search.replace(/[^\d٠-٩۰-۹]/g, "").length >= 7 && <button type="button" onClick={() => void searchPhoneHistory()} disabled={searchingPhone} className="mt-2 w-full rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px] font-bold text-emerald-800 disabled:opacity-50">{searchingPhone ? "جارٍ البحث في سجل WhatsApp..." : "بحث شامل برقم الهاتف"}</button>}
              {phoneSearchError && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[10px] leading-5 text-red-700">{phoneSearchError}</p>}
              {phoneSearchResult && <div className="mt-2 rounded-xl border border-emerald-100 bg-white p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2"><span className="truncate text-[10px] font-extrabold">{phoneSearchResult.customer ? customerDisplayName(phoneSearchResult.customer) : `+${phoneSearchResult.phone}`}</span><span className="shrink-0 text-[9px] text-stone-400">{phoneSearchResult.conversations.length ? `${phoneSearchResult.conversations.length} محادثة` : "لا يوجد سجل سابق"}</span></div>
                <div className="soft-scroll max-h-32 space-y-1 overflow-y-auto">{phoneSearchResult.conversations.map((conversation: AnyRecord) => <button key={conversation.id} type="button" onClick={() => { setPhoneSearchResult(null); void openChat(conversation.id); }} className="flex w-full items-center justify-between gap-2 rounded-lg bg-stone-50 px-2.5 py-2 text-right hover:bg-emerald-50"><span className="min-w-0"><span className="block truncate text-[10px] font-bold">{customerDisplayName(conversation.customer)}</span><span className="mt-0.5 block truncate text-[9px] text-stone-400">{conversation.messages?.[0]?.text || "مرفق أو رسالة"}{conversation.readOnly ? " · قراءة فقط" : ""}</span></span><span className="shrink-0 text-[9px] text-stone-400">{ago(conversation.lastMessageAt)}</span></button>)}</div>
                <button type="button" onClick={() => void startChatFromPhone()} disabled={startingPhoneChat || (user?.channelAccess ? user.channelAccess.WHATSAPP !== "FULL" : user?.canReceiveWhatsApp === false) || Boolean(phoneSearchResult.customer?.isBlocked)} className="mt-2 w-full rounded-lg bg-emerald-700 px-3 py-2 text-[10px] font-bold text-white disabled:cursor-not-allowed disabled:bg-stone-300">{startingPhoneChat ? "جارٍ فتح WhatsApp..." : phoneSearchResult.customer?.isBlocked ? "العميل محظور" : "فتح أو بدء محادثة WhatsApp"}</button>
              </div>}
            <div className="soft-scroll mt-3 flex gap-1 overflow-x-auto pb-2">{availableChannels.map((item) => <button key={item.id} onClick={() => selectChannelFilter(item.id)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${filter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>{item.label}</button>)}</div>
            {filter === "WHATSAPP" && <div role="group" aria-label="نوع محادثة WhatsApp" className="soft-scroll -mt-1 mb-2 flex gap-1 overflow-x-auto pb-2">{[{ id: "ALL", label: "الكل" }, { id: "DIRECT", label: "الأفراد" }, { id: "GROUPS", label: "المجموعات" }].map((item) => <button key={item.id} type="button" aria-pressed={whatsappGroupFilter === item.id} onClick={() => selectWhatsAppConversationKind(item.id as "ALL" | "DIRECT" | "GROUPS")} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${whatsappGroupFilter === item.id ? "bg-emerald-700 text-white" : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100"}`}>{item.label}</button>)}</div>}
               <div className="soft-scroll flex gap-1 overflow-x-auto pb-3">{[{ id: "ACTIVE", label: "نشطة" }, { id: "ARCHIVED", label: "مؤرشفة" }, { id: "TEAM", label: "كل المحادثات" }, { id: "HISTORY", label: "سجل محادثاتي" }, { id: "FAVORITES", label: "المفضلة" }, { id: "STARRED", label: "الرسائل المميزة" }, { id: "PINNED", label: "المثبتة" }, { id: "RESOLVED", label: "تم الحل" }, { id: "CLOSED", label: "مغلقة" }, { id: "ALL", label: "الكل" }].map((item) => <button key={item.id} onClick={() => selectStatusFilter(item.id)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${statusFilter === item.id ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>{item.label}</button>)}</div>
          </div>
          {chatLoadError && <div role="alert" className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-[10px] text-red-800"><span>{chatLoadError}</span><button type="button" onClick={() => void loadChats()} className="shrink-0 font-bold underline">إعادة المحاولة</button></div>}
            <div className="soft-scroll flex-1 overflow-y-auto border-t border-stone-100">
              {statusFilter === "STARRED" ? <>
                {starredMessages.map((item) => <button key={item.id} type="button" onClick={() => void openChat(item.conversationId, item.id)} className="flex w-full items-center gap-3 border-b border-stone-100 bg-white px-4 py-3 text-right hover:bg-amber-50">
                  <Avatar name={customerDisplayName(item.conversation?.customer)} src={item.conversation?.customer?.avatarUrl} />
                  <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><b className="truncate text-xs">{customerDisplayName(item.conversation?.customer)}</b><ChannelIcon channel={item.conversation?.channel || "WHATSAPP"} /></span><span className="mt-1 block truncate text-[10px] text-stone-500">{item.message?.text || ({ IMAGE: "صورة", STICKER: "ملصق", AUDIO: "رسالة صوتية", VIDEO: "فيديو", FILE: "ملف مرفق", LOCATION: "موقع" } as Record<string, string>)[item.message?.kind] || "رسالة مميزة"}</span><span className="mt-1 block text-[9px] text-stone-400">{formatCairoDateTime(item.message?.createdAt)} · {ago(item.starredAt)}</span></span>
                  <Star size={15} fill="currentColor" className="shrink-0 text-amber-500" />
                </button>)}
                {!starredMessages.length && <p className="px-4 py-12 text-center text-xs text-stone-400">لم تحفظ أي رسائل مميزة بعد. استخدم النجمة بجانب الرسالة لإضافتها هنا.</p>}
              </> : hasGlobalSearchQuery ? <>
                {globalSearchLoading && !globalSearchResults.length && <p role="status" className="px-4 py-10 text-center text-xs text-stone-400">جارٍ البحث في الأسماء والأرقام والرسائل...</p>}
                {globalSearchError && <p role="alert" className="px-4 py-6 text-center text-xs text-red-700">{globalSearchError}</p>}
                {globalSearchResults.map((result) => <article key={result.id} className="border-b border-stone-100 bg-white px-3 py-3">
                  <button type="button" onClick={() => void openChat(result.id)} className="flex w-full items-center gap-3 text-right hover:text-emerald-800">
                    <Avatar name={customerDisplayName(result.customer)} src={result.customer?.avatarUrl} />
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><b className="truncate text-xs"><HighlightedText text={customerDisplayName(result.customer)} query={search.trim()} /></b>{isWhatsAppGroupConversation(result) && <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800">مجموعة</span>}<ChannelIcon channel={result.channel} /></span><span className="mt-1 block truncate text-[10px] text-stone-400">{isWhatsAppGroupConversation(result) ? "مجموعة WhatsApp · " : result.customer?.phone ? <><HighlightedText text={result.customer.phone} query={search.trim()} /> · </> : null}{result.matchType === "CUSTOMER" ? "مطابقة بيانات العميل" : "مطابقة في الرسائل"} · {conversationStatusLabel(result.status)}</span></span>
                    <span className="shrink-0 text-[9px] text-stone-400">{ago(result.lastMessageAt)}</span>
                  </button>
                  {result.messages?.length ? <div className="mt-2 space-y-1.5 border-r-2 border-emerald-100 pr-2">{result.messages.map((message: AnyRecord) => <button key={message.id} type="button" onClick={() => void openChat(result.id, message.id)} className="block w-full rounded-lg bg-stone-50 px-2.5 py-2 text-right text-[10px] leading-5 text-stone-600 hover:bg-emerald-50"><span className="mb-0.5 block text-[9px] font-bold text-emerald-700">{message.transcription && !message.text ? "تفريغ رسالة صوتية" : "رسالة مطابقة"} · {ago(message.createdAt)}</span><span className="line-clamp-2"><HighlightedText text={message.transcription || message.text || "رسالة مرفقة"} query={search.trim()} /></span></button>)}</div> : <button type="button" onClick={() => void openChat(result.id)} className="mt-2 w-full rounded-lg bg-stone-50 px-2.5 py-2 text-right text-[10px] font-semibold text-stone-500 hover:bg-emerald-50">افتح المحادثة المطابقة</button>}
                </article>)}
                {!globalSearchLoading && !globalSearchError && !globalSearchResults.length && <p className="px-4 py-10 text-center text-xs text-stone-400">لا توجد نتائج مطابقة.</p>}
                {globalSearchHasMore && <button type="button" onClick={() => void loadMoreGlobalSearch()} disabled={globalSearchLoading} className="m-3 w-[calc(100%-1.5rem)] rounded-xl border border-stone-200 bg-white px-3 py-2 text-[10px] font-bold text-stone-600 disabled:opacity-50">{globalSearchLoading ? "جارٍ التحميل..." : "عرض نتائج إضافية"}</button>}
              </> : <>{visible.map((chat) => <article key={chat.id} className={`group relative border-b border-stone-100 ${activeId === chat.id ? "bg-[#fff6e4]" : "bg-white"}`} style={{ touchAction: "pan-y" }} onPointerDown={(event) => startConversationGesture(event, chat.id)} onPointerMove={moveConversationGesture} onPointerUp={endConversationGesture} onPointerCancel={endConversationGesture} onContextMenu={(event) => { event.preventDefault(); setSwipedConversationId(""); setListMenuConversationId(""); setOpenConversationMenuId(chat.id); }}>
                <button type="button" onClick={() => { if (suppressConversationClickRef.current) { suppressConversationClickRef.current = false; return; } setSwipedConversationId(""); void openChat(chat.id); }} className="flex w-full gap-3 px-4 py-3 text-right transition hover:bg-[#fffaf2]">
                  <div className="relative"><Avatar name={customerDisplayName(chat.customer)} src={chat.customer?.avatarUrl} />{chat.unreadCount > 0 && <span className="absolute -left-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#d32f2f] px-1 text-[9px] font-bold text-white">{chat.unreadCount}</span>}{chat.personalState?.isMuted && <BellOff size={12} className="absolute -bottom-1 -right-1 rounded-full bg-white text-stone-500" />}</div>
                    <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-1"><span className="flex min-w-0 items-center gap-1.5"><b className="truncate text-xs">{customerDisplayName(chat.customer)}</b>{isWhatsAppGroupConversation(chat) && <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800">مجموعة</span>}</span><span className="shrink-0 text-[9px] text-stone-400">{ago(chat.lastMessageAt)}</span></div>{!isWhatsAppGroupConversation(chat) && customerIdentityPreview(chat.customer, chat.channel, chat.externalCustomerId) && <div dir="ltr" className="mt-0.5 truncate text-left text-[9px] font-semibold text-stone-500">{customerIdentityPreview(chat.customer, chat.channel, chat.externalCustomerId)}</div>}<div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-[10px] text-stone-400">{chat.messages?.[0]?.text || (chat.personalState?.clearedAt ? "محادثة ممسوحة من حسابك" : "مرفق أو رسالة")}</span><ChannelIcon channel={chat.channel} /></div>{conversationActivities[chat.id] && <span role="status" className="mt-1 inline-block text-[9px] font-semibold text-emerald-700">{conversationActivities[chat.id].actor === "customer" ? `العميل ${conversationActivities[chat.id].activity === "recording" ? "🎙️ جاري تسجيل مقطع صوتي..." : "جاري الكتابة..."}` : `${conversationActivities[chat.id].actorName || "الموظف"} ${conversationActivities[chat.id].activity === "recording" ? "يسجل صوتًا..." : "يكتب..."}`}</span>}{statusFilter === "TEAM" && <span className="mt-1 inline-block rounded-md bg-stone-100 px-1.5 py-0.5 text-[9px] text-stone-500">{chat.assignedAgent?.name ? `مسندة إلى ${chat.assignedAgent.name}` : "في الطابور"}{chat.readOnly ? " · قراءة فقط" : " · مسؤوليتك"}</span>}{chat.serviceTag && <span className="mt-1 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">{chat.serviceTag}</span>}{chat.slaBreachedAt && <span className="mt-1 mr-1 inline-block rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-600">تجاوزت المهلة</span>}</div>
                </button>
                {(chat.unreadCount > 0 || isWaitingForAgent(chat)) && <div className="flex items-center gap-1.5 px-4 pb-2">{isWaitingForAgent(chat) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-bold text-amber-800">بانتظار الرد</span>}{chat.unreadCount > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[9px] font-bold text-red-700">غير مقروء · {chat.unreadCount}</span>}</div>}
                <button type="button" aria-label={`المزيد من الخيارات لمحادثة ${customerDisplayName(chat.customer)}`} aria-haspopup="menu" aria-expanded={openConversationMenuId === chat.id} onClick={() => openConversationMenu(chat.id)} className={`absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-white/95 text-stone-500 shadow-sm ring-1 ring-stone-200 hover:bg-amber-50 hover:text-amber-800 focus-visible:opacity-100 ${swipedConversationId === chat.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}><MoreHorizontal size={17} /></button>
                {openConversationMenuId === chat.id && <div ref={conversationMenuRef} role="menu" aria-label={`إجراءات ${customerDisplayName(chat.customer)}`} className="absolute left-2 top-2 z-30 max-h-[70vh] w-60 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                  <button type="button" role="menuitem" onClick={() => void updatePersonalConversationSettings(chat.id, { markRead: true }, "تم تمييز المحادثة كمقروءة في حسابك فقط.")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-emerald-50"><CheckCheck size={16} className="shrink-0 text-emerald-700" /><span className="text-xs font-bold">تمييز كمقروءة</span></button>
                  <button type="button" role="menuitem" onClick={() => void updatePersonalConversationSettings(chat.id, { isArchived: !chat.personalState?.isArchived }, chat.personalState?.isArchived ? "أُعيدت المحادثة إلى قائمتك النشطة." : "أُرشفت المحادثة في حسابك فقط.")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-amber-50"><Archive size={16} className="shrink-0 text-amber-700" /><span className="text-xs font-bold">{chat.personalState?.isArchived ? "إلغاء الأرشفة" : "أرشفة"}</span></button>
                  <button type="button" role="menuitem" onClick={() => void updatePersonalConversationSettings(chat.id, { isMuted: !chat.personalState?.isMuted }, chat.personalState?.isMuted ? "أُلغي كتم التنبيهات في حسابك." : "كُتمت تنبيهات هذه المحادثة في حسابك.")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-stone-50"><BellOff size={16} className="shrink-0 text-stone-500" /><span className="text-xs font-bold">{chat.personalState?.isMuted ? "إلغاء كتم التنبيهات" : "كتم التنبيهات"}</span></button>
                  <button type="button" role="menuitem" onClick={() => void toggleConversationFavorite(chat.id)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-amber-50"><Star size={16} className="shrink-0 text-amber-500" fill={favoriteIds.includes(chat.id) ? "currentColor" : "none"} /><span className="text-xs font-bold">{favoriteIds.includes(chat.id) ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}</span></button>
                  <button type="button" role="menuitem" aria-expanded={listMenuConversationId === chat.id} onClick={() => void showConversationLists(chat.id)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-blue-50"><ListChecks size={16} className="shrink-0 text-blue-700" /><span className="text-xs font-bold">إضافة إلى قائمة</span></button>
                  {listMenuConversationId === chat.id && <div role="group" aria-label="قوائمك الشخصية" className="my-1 space-y-1 border-y border-stone-100 py-1">{conversationLists.map((list) => <button key={list.id} type="button" role="menuitem" onClick={() => void addConversationToList(chat.id, list)} className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-right text-[11px] text-stone-600 hover:bg-blue-50"><span className="truncate">{list.name}</span><span className="shrink-0 text-[9px] text-stone-400">{list.itemCount || 0}</span></button>)}<button type="button" role="menuitem" onClick={() => void createConversationListForChat(chat.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right text-[11px] font-bold text-blue-800 hover:bg-blue-50">قائمة شخصية جديدة</button></div>}
                  <button type="button" role="menuitem" disabled={!chat.customer?.id || chat.readOnly || savingCustomerFlags} onClick={() => void toggleConversationBlock(chat)} title={chat.readOnly ? "الحظر متاح للمحادثات المسندة إليك" : undefined} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-red-700 hover:bg-red-50 disabled:opacity-50"><Ban size={16} className="shrink-0" /><span className="text-xs font-bold">{chat.customer?.isBlocked ? "إلغاء الحظر للجميع" : "حظر العميل للجميع"}</span></button>
                  <button type="button" role="menuitem" onClick={() => { if (window.confirm("مسح سجل الدردشة من حسابك فقط؟ ستظل الرسائل محفوظة في النظام ولن تتأثر حسابات زملائك.")) void updatePersonalConversationSettings(chat.id, { clear: true }, "مُسح سجل الدردشة من حسابك فقط."); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-stone-50"><Eraser size={16} className="shrink-0 text-stone-500" /><span className="text-xs font-bold">مسح الدردشة من حسابي</span></button>
                  <button type="button" role="menuitem" onClick={() => { if (window.confirm("إزالة المحادثة من قائمتك الشخصية فقط؟ سيبقى سجلها محفوظًا للزملاء ولن تُحذف رسائل النظام.")) void updatePersonalConversationSettings(chat.id, { isDeleted: true }, "أُزيلت المحادثة من قائمتك الشخصية."); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-red-700 hover:bg-red-50"><Trash2 size={16} className="shrink-0" /><span className="text-xs font-bold">حذف من قائمتي فقط</span></button>
                </div>}
              </article>)}{!visible.length && <div className="px-4 py-12 text-center text-xs text-stone-400">لا توجد محادثات هنا بعد.</div>}</>}
            </div>
        {hasMoreChats && <button type="button" onClick={() => void loadMoreChats()} disabled={loadingMoreChats} className="m-3 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[10px] font-bold text-stone-600 hover:bg-stone-50 disabled:opacity-50">{loadingMoreChats ? "جارٍ تحميل المزيد..." : "تحميل المزيد من المحادثات"}</button>}
        <div className="space-y-2 border-t border-stone-100 px-4 py-3 text-[10px] text-stone-400"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> متصل بالنظام</span><span className="truncate">{user?.email}</span></div><div className="flex items-center justify-between gap-2 border-t border-stone-100 pt-2"><a href="tel:+201018040600" className="font-semibold text-stone-500 hover:text-amber-800">برمجة م/ محمود سلامه</a><a href="https://wa.me/201018040600" target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 hover:text-emerald-800">واتساب</a></div></div>
       </aside>

       {showConversationSidebar && <div
         role="separator"
         aria-orientation="vertical"
         aria-label="تغيير عرض قائمة المحادثات"
         aria-controls="conversation-list"
         aria-valuemin={MIN_CONVERSATION_SIDEBAR_WIDTH}
         aria-valuemax={MAX_CONVERSATION_SIDEBAR_WIDTH}
         aria-valuenow={conversationSidebarWidth}
         aria-valuetext={`${conversationSidebarWidth} بكسل`}
         tabIndex={0}
         className="workspace-splitter"
         onPointerDown={startConversationSidebarResize}
         onPointerMove={moveConversationSidebarResize}
         onPointerUp={endConversationSidebarResize}
         onPointerCancel={endConversationSidebarResize}
         onDoubleClick={() => setConversationSidebarWidth(285)}
         onKeyDown={(event) => {
           const step = event.shiftKey ? 32 : 16;
           if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
             event.preventDefault();
             setConversationSidebarWidth((width) => clampConversationSidebarWidth(width + (event.key === "ArrowRight" ? step : -step)));
           }
         }}
       />}

       <section className="workspace-chat panel relative flex min-h-0 flex-col overflow-hidden bg-[#fffdf7]" onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) setIsDraggingFile(true); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingFile(false); }} onDrop={(event) => { event.preventDefault(); setIsDraggingFile(false); const files = Array.from(event.dataTransfer.files || []); if (files.length) void uploadSelectedFiles(files); }}>
         <input ref={uploadInputRef} type="file" multiple className="hidden" accept="image/jpeg,image/png,image/webp,audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/aac,video/mp4,video/3gpp,video/quicktime,application/pdf,text/plain,.doc,.docx,.xls,.xlsx" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void uploadSelectedFiles(files); }} />
         <input ref={stickerInputRef} type="file" className="hidden" accept="image/webp,.webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadAndSend(file); }} />
        {isDraggingFile && detail && <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-2 border-dashed border-emerald-500 bg-emerald-50/90 text-lg font-extrabold text-emerald-800">أفلت الصورة أو ملصق WebP أو الصوت أو الفيديو أو الملف لإرساله</div>}
        {detail ? <>
               <button type="button" onClick={returnToChatList} aria-label="العودة إلى قائمة المحادثات دون إغلاقها" title="العودة إلى قائمة المحادثات دون إغلاقها" className="conversation-view-back"><ArrowRight size={16} /> العودة إلى المحادثات</button>
               <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-stone-100 bg-white px-2 sm:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <button type="button" onClick={openCustomerProfile} title={`فتح ملف العميل: ${customerDisplayName(detail.customer)}`} aria-label={`فتح ملف العميل: ${customerDisplayName(detail.customer)}`} className="flex min-w-0 flex-1 items-center gap-2 text-right hover:text-amber-800 sm:gap-3">
                 <Avatar name={customerDisplayName(detail.customer)} src={detail.customer?.avatarUrl} />
                  <span className="min-w-0"><span className="line-clamp-2 break-words text-xs font-extrabold sm:text-sm">{customerDisplayName(detail.customer)} {isWhatsAppGroupConversation(detail) && <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800">مجموعة</span>} {detail.isComplaint && <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600">شكوى</span>}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9px] text-stone-400 sm:text-[10px]"><ChannelIcon channel={detail.channel} />{isWhatsAppGroupConversation(detail) ? "مجموعة WhatsApp" : detail.customer?.phone ? displayPhoneNumber(detail.customer.phone) : channelName(detail.channel)}<span className="rounded-full bg-emerald-50 px-1.5 py-0.5 font-bold text-emerald-700">{conversationStatusLabel(detail.status)}</span>{detail.serviceTag && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800">{detail.serviceTag}</span>}</span>
                 </span>
                </button>
                <CopyableCustomerIdentities customer={detail.customer} channel={detail.channel} externalCustomerId={detail.externalCustomerId} compact />
                </div>
                 <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
                 <fieldset disabled={Boolean(detail.readOnly)} className="contents">
                   <button type="button" disabled title="مكالمات الفيديو غير متاحة حاليًا؛ النظام يدعم المكالمات الصوتية فقط" aria-label="مكالمة فيديو غير متاحة" className="grid h-8 w-8 place-items-center rounded-lg text-stone-300 disabled:cursor-not-allowed"><Video size={16} /></button>
                    {detail.channel === "WHATSAPP" && !isWhatsAppGroupConversation(detail) && <button type="button" disabled={!callTarget || detail.customer?.isBlocked || Boolean(callConversation)} title={callConversation ? "أنه المكالمة الحالية أولًا" : !callTarget ? "أضف رقمًا إلى ملف العميل أولًا" : detail.customer?.isBlocked ? "العميل محظور داخل النظام" : "مكالمة صوتية عبر WhatsApp"} aria-label="مكالمة صوتية عبر WhatsApp" onClick={() => setCallConversation(detail)} className="grid h-8 w-8 place-items-center rounded-lg text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"><PhoneCall size={16} /></button>}
                 </fieldset>
                 <button type="button" onClick={() => { setShowConversationSearch((open) => !open); setConversationSearchQuery(""); setConversationSearchMatches([]); }} title="البحث داخل المحادثة" aria-label="البحث داخل المحادثة" aria-expanded={showConversationSearch} className={`grid h-8 w-8 place-items-center rounded-lg ${showConversationSearch ? "bg-amber-50 text-amber-800" : "text-stone-500 hover:bg-stone-100"}`}><Search size={16} /></button>
                  <div ref={headerOptionsRef} className="relative">
                    <button type="button" title="خيارات المحادثة" aria-label="خيارات المحادثة" aria-haspopup="menu" aria-expanded={showHeaderOptions} onClick={() => setShowHeaderOptions((open) => !open)} className={`grid h-8 w-8 place-items-center rounded-lg ${showHeaderOptions ? "bg-stone-100 text-stone-700" : "text-stone-400 hover:bg-stone-100"}`}><MoreHorizontal size={18} /></button>
                    {showHeaderOptions && <div role="menu" aria-label="إجراءات المحادثة" className="absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl">
                      <button type="button" role="menuitem" onClick={() => { setShowHeaderOptions(false); openCustomerProfile(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-amber-50"><BookUser size={16} className="shrink-0 text-amber-700" /><span className="text-xs font-bold">ملف العميل</span></button>
                      <div className="my-1 border-t border-stone-100" />
                       {detail.channel === "WHATSAPP" && !isWhatsAppGroupConversation(detail) && <button type="button" role="menuitem" disabled={Boolean(detail.readOnly) || !callTarget || detail.customer?.isBlocked || Boolean(callConversation)} title={detail.readOnly ? "محادثة للقراءة فقط" : callConversation ? "أنه المكالمة الحالية أولًا" : !callTarget ? "أضف رقمًا إلى ملف العميل أولًا" : detail.customer?.isBlocked ? "العميل محظور داخل النظام" : undefined} onClick={() => { setShowHeaderOptions(false); setCallConversation(detail); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"><PhoneCall size={16} className="shrink-0" /><span className="text-xs font-extrabold">مكالمة WhatsApp داخل النظام</span></button>}
                      <button type="button" role="menuitem" disabled={Boolean(detail.readOnly)} onClick={() => { setShowHeaderOptions(false); void toggleFavorite(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40"><Star size={16} className="shrink-0 text-amber-500" fill={favoriteIds.includes(activeId) ? "currentColor" : "none"} /><span className="text-xs font-bold">{favoriteIds.includes(activeId) ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}</span></button>
                      <button type="button" role="menuitem" disabled={Boolean(detail.readOnly)} onClick={() => { setShowHeaderOptions(false); void deferConversation(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"><Clock3 size={16} className="shrink-0 text-stone-400" /><span className="text-xs font-bold">تأجيل للمتابعة لاحقًا</span></button>
                        {!detail.readOnly && user?.role === "AGENT" && (detail.channel === "MESSENGER" || user.department === "CUSTOMER_CARE") && <button type="button" role="menuitem" onClick={() => { setShowHeaderOptions(false); void openHandoffDialog(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-stone-700 hover:bg-amber-50"><Users size={16} className="shrink-0 text-amber-700" /><span className="text-xs font-bold">تحويل لزميل متاح</span></button>}
                      <div className="my-1 border-t border-stone-100" />
                      <button type="button" role="menuitem" disabled={Boolean(detail.readOnly)} onClick={() => { setShowHeaderOptions(false); void resolveConversation(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-right text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"><CheckCircle2 size={16} className="shrink-0" /><span className="text-xs font-bold">تم الحل وإرسال استبيان الرضا</span></button>
                    </div>}
                  </div>
                 <button type="button" onClick={() => void closeConversation()} disabled={Boolean(detail.readOnly)} title={detail.readOnly ? "محادثة للقراءة فقط" : "إغلاق المحادثة"} aria-label="إغلاق المحادثة" className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"><X size={17} /></button>
                </div>
              </div>
              {showConversationSearch && <div className="flex shrink-0 items-center gap-2 border-b border-amber-100 bg-[#fffaf0] px-3 py-2">
                <Search size={15} className="shrink-0 text-amber-700" />
                <input ref={conversationSearchInputRef} value={conversationSearchQuery} onChange={(event) => setConversationSearchQuery(event.target.value)} placeholder="ابحث في رسائل هذه المحادثة" aria-label="ابحث داخل المحادثة" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-stone-400" />
                <span role="status" className="shrink-0 text-[9px] text-stone-500">{conversationSearchLoading ? "جارٍ البحث" : conversationSearchTotal ? `${conversationSearchIndex + 1} / ${conversationSearchTotal}` : conversationSearchQuery.trim().length >= 2 ? "لا نتائج" : ""}</span>
                <button type="button" disabled={!conversationSearchTotal || conversationSearchIndex <= 0} onClick={() => void moveConversationSearchMatch(-1)} aria-label="النتيجة السابقة" title="النتيجة السابقة" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-stone-500 hover:bg-white disabled:opacity-30"><ArrowRight size={15} /></button>
                <button type="button" disabled={!conversationSearchTotal || conversationSearchIndex >= conversationSearchTotal - 1} onClick={() => void moveConversationSearchMatch(1)} aria-label="النتيجة التالية" title="النتيجة التالية" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-stone-500 hover:bg-white disabled:opacity-30"><ArrowLeft size={15} /></button>
                <button type="button" onClick={() => { setShowConversationSearch(false); setConversationSearchQuery(""); setHighlightedMessageId(""); }} aria-label="إغلاق البحث داخل المحادثة" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-white"><X size={15} /></button>
              </div>}
             {detail.customer?.isBlocked && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-[10px] font-bold text-red-800"><Ban size={14} /> العميل محظور داخل النظام؛ لا يمكن إرسال ردود أو منتجات إليه.</div>}
                <div className="desktop-sidebar-controls flex h-9 shrink-0 items-center justify-end border-b border-stone-100 bg-white px-2">
                  <div className="flex items-center gap-1">
                   <button type="button" onClick={() => setShowConversationSidebar((shown) => !shown)} aria-pressed={showConversationSidebar} title={showConversationSidebar ? "إخفاء قائمة المحادثات" : "إظهار قائمة المحادثات"} aria-label={showConversationSidebar ? "إخفاء قائمة المحادثات" : "إظهار قائمة المحادثات"} className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100"><PanelLeft size={16} /></button>
                 </div>
               </div>
              {metaChannel && <div className={`flex shrink-0 items-center gap-2 px-4 py-2 text-[10px] font-bold ${!metaWindowOpen ? "bg-red-50 text-red-700" : expiringSoon ? "bg-[#FFC107]/20 text-[#8c650a]" : "bg-emerald-50 text-emerald-700"}`}><Clock3 size={14} />{metaWindowOpen ? `نافذة Meta مفتوحة · متبقي ${formatCountdown(windowRemaining)}` : "انتهت نافذة الـ24 ساعة للرد الحر"}{detail.isComplaint && <span className="mr-auto rounded-full bg-red-100 px-2 py-0.5 text-red-700">شكوى · خدمة العملاء</span>}</div>}
           {watching && <div className="flex h-9 shrink-0 items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 text-[11px] font-semibold text-blue-700"><Users size={14} /> المدير يراقب هذه المحادثة معك الآن</div>}
            {customerActivity && <div role="status" aria-live="polite" className="flex h-8 shrink-0 items-center gap-2 border-b border-emerald-100 bg-emerald-50 px-4 text-[10px] font-semibold text-emerald-800"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />{customerActivity === "recording" ? "🎙️ جاري تسجيل مقطع صوتي..." : "جاري الكتابة..."}</div>}
           {notice && <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-900"><span>{notice}</span><button onClick={() => setNotice("")}><span>×</span></button></div>}
              {detail.readOnly && <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-[10px] font-bold text-amber-900">للقراءة فقط · لا يمكن الرد على العميل أو تعديل المحادثة؛ يمكنك مراسلة زميل سرًا</div>}
               <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-stone-200/70 bg-[#f0f2f5] px-3 text-[10px] text-stone-500">
                 <label className="flex min-w-0 items-center gap-2">
                   <span className="sr-only">تصفية الرسائل</span>
                   <select value={messageFilter} onChange={(event) => setMessageFilter(event.target.value)} className="h-8 max-w-36 rounded-lg border border-stone-200 bg-white px-2 text-[10px] font-bold text-stone-600 outline-none focus:border-amber-400">
                     {[{ id: "ALL", label: "كل الرسائل" }, { id: "IMAGES", label: "الصور" }, { id: "AUDIO", label: "الصوت" }, { id: "VIDEO", label: "الفيديو" }, { id: "FILES", label: "الملفات" }, { id: "LINKS", label: "الروابط" }].map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                   </select>
                  </label>
                  <button type="button" aria-label={selectionMode ? "إلغاء تحديد الرسائل" : "تحديد رسائل متعددة"} aria-pressed={selectionMode} title={selectionMode ? "إلغاء تحديد الرسائل" : "تحديد رسائل متعددة"} onClick={() => selectionMode ? clearMessageSelection() : setSelectionMode(true)} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${selectionMode ? "bg-emerald-700 text-white" : "bg-white text-stone-500 hover:bg-emerald-50 hover:text-emerald-800"}`}><ListChecks size={15} /></button>
                  <details className="relative shrink-0">
                   <summary className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-lg border border-stone-200 bg-white px-2 font-bold text-stone-600"><span aria-hidden="true">Aa</span><span>{chatFontSize}</span></summary>
                   <div role="group" aria-label="حجم خط الرسائل" className="absolute left-0 top-full z-20 mt-2 flex items-center gap-2 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
                     <span className="whitespace-nowrap text-[10px]">حجم الخط</span>
                     <button type="button" aria-label="تصغير خط الرسائل" disabled={chatFontSize <= 14} onClick={() => { const next = Math.max(14, chatFontSize - 1); setChatFontSize(next); localStorage.setItem("bondoq_chat_font_size", String(next)); }} className="grid h-7 w-7 place-items-center rounded-lg bg-stone-100 text-sm font-bold disabled:opacity-40">−</button>
                     <b className="min-w-7 text-center">{chatFontSize}</b>
                     <button type="button" aria-label="تكبير خط الرسائل" disabled={chatFontSize >= 28} onClick={() => { const next = Math.min(28, chatFontSize + 1); setChatFontSize(next); localStorage.setItem("bondoq_chat_font_size", String(next)); }} className="grid h-7 w-7 place-items-center rounded-lg bg-stone-100 text-sm font-bold disabled:opacity-40">+</button>
                   </div>
                 </details>
               </div>
               <div ref={messageListRef} onScroll={(event) => { const element = event.currentTarget; const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120; stickToBottom.current = atBottom; setShowJumpToBottom(!atBottom); }} className="chat-message-list soft-scroll relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3 sm:px-5">
              {detail.hasMoreMessages && <button type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages} className="mx-auto rounded-full border border-stone-200 bg-white px-4 py-2 text-[10px] font-bold text-stone-600 shadow-sm disabled:opacity-50">{loadingOlderMessages ? "جارٍ تحميل الرسائل..." : "تحميل الرسائل الأقدم"}</button>}
            <div className="mx-auto rounded-full bg-white px-3 py-1 text-[9px] text-stone-400 shadow-sm">بدأت المحادثة · {formatCairoDateTime(detail.createdAt, false)}</div>
                   {displayedMessages.map((message: AnyRecord) => <Message key={message.id} message={message} conversationId={detail.id} readOnly={Boolean(detail.readOnly)} selectionMode={selectionMode} selected={selectedMessageIds.includes(message.id)} onToggleSelection={() => toggleMessageSelection(message.id)} highlighted={highlightedMessageId === message.id} highlightQuery={highlightedMessageId === message.id ? conversationSearchQuery || search : ""} onQuote={() => { setReplyingTo(message); replyInputRef.current?.focus(); }} onEdit={detail.channel !== "MESSENGER" && message.direction === "OUTBOUND" && message.authorId === user?.id && message.kind === "TEXT" && message.deliveryStatus === "SENT" ? () => beginMessageEdit(message) : undefined} onDelete={message.direction === "OUTBOUND" && message.authorId === user?.id && message.externalId && ["SENT", "DELIVERED", "READ", "PLAYED"].includes(message.deliveryStatus) ? () => void deleteSentMessage(message) : undefined} deleting={deletingMessageId === message.id} onForward={() => setForwardMessage({ ...message, conversationId: detail.id })} editing={editingMessageId === message.id} editingText={editingText} onEditingTextChange={setEditingText} onSaveEdit={() => void saveMessageEdit(message)} onCancelEdit={() => { setEditingMessageId(""); setEditingText(""); }} savingEdit={savingEdit} onReact={(emoji) => void reactToMessage(message, emoji)} onOpenImage={setLightboxImage} />)}
                 {hasMoreNewerMessages && <button type="button" onClick={() => void loadNewerMessages()} disabled={loadingNewerMessages} className="mx-auto rounded-full border border-stone-200 bg-white px-4 py-2 text-[10px] font-bold text-stone-600 shadow-sm disabled:opacity-50">{loadingNewerMessages ? "جارٍ تحميل الرسائل الأحدث..." : "تحميل الرسائل الأحدث"}</button>}
             {(detail.whisperNotes || []).map((note: AnyRecord) => <div key={`whisper-${note.id}`} className="mx-auto w-full max-w-xl rounded-xl border border-[#f0d786] bg-[#fff8e1] px-4 py-3 text-xs leading-6 text-[#755916]"><div className="mb-1 flex items-center gap-1.5 font-extrabold"><CakeSlice size={14} /> توجيه سري من {note.author?.name || "المدير"}<span className="mr-auto text-[9px] font-normal text-[#aa8a36]">{ago(note.createdAt)}</span></div>{note.text}</div>)}
              {(detail.privateNotes || []).map((note: AnyRecord) => <div key={`private-note-${note.id}`} className="mx-auto w-full max-w-xl rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-xs leading-6 text-violet-950"><div className="mb-1 flex items-center gap-1.5 font-extrabold"><LockKeyhole size={13} /> رسالة سرية {note.authorId === user?.id ? `إلى ${note.recipient?.name || "زميل"}` : `من ${note.author?.name || "زميل"}`}<span className="mr-auto text-[9px] font-normal text-violet-500">{ago(note.createdAt)}</span></div>{note.text}</div>)}
             <div className="mt-auto" /><div ref={messageEndRef} />
             {showJumpToBottom && <button type="button" onClick={() => { stickToBottom.current = true; messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); setShowJumpToBottom(false); }} className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white shadow-lg"><ArrowDown size={13} /> الرسائل الجديدة</button>}
           </div>
           {selectionMode && <div role="toolbar" aria-label="إجراءات الرسائل المحددة" className="message-selection-toolbar flex shrink-0 items-center justify-between gap-2 border-t border-emerald-100 bg-white px-3 py-2 shadow-[0_-4px_14px_rgba(15,23,42,.04)]">
             <div className="flex min-w-0 items-center gap-2">
               <button type="button" onClick={clearMessageSelection} aria-label="إلغاء تحديد الرسائل" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100"><X size={17} /></button>
               <span className="truncate text-xs font-bold text-stone-700">{selectedMessages.length} رسالة محددة</span>
             </div>
             <div className="flex shrink-0 items-center gap-1">
               <button type="button" onClick={() => void copySelectedMessages()} aria-label="نسخ الرسائل المحددة" title="نسخ الرسائل المحددة" disabled={!selectedMessages.length} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[10px] font-bold text-stone-600 hover:bg-stone-100 disabled:opacity-40"><Copy size={15} /><span className="hidden sm:inline">نسخ</span></button>
               {!detail.readOnly && <button type="button" onClick={() => void deleteSelectedMessages()} aria-label="حذف الرسائل المحددة" title="حذف الرسائل المحددة" disabled={!deletableSelectedMessages.length || deletingSelectedMessages || Boolean(deletingMessageId)} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[10px] font-bold text-red-700 hover:bg-red-50 disabled:opacity-40"><Trash2 size={15} /><span className="hidden sm:inline">حذف</span></button>}
               {!detail.readOnly && <button type="button" onClick={() => { setForwardMessage({ conversationId: detail.id, messages: forwardableSelectedMessages }); setForwardQuery(""); }} aria-label="تحويل الرسائل المحددة" title="تحويل الرسائل المحددة" disabled={!forwardableSelectedMessages.length || forwardingMessages} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[10px] font-bold text-emerald-800 hover:bg-emerald-50 disabled:opacity-40"><Forward size={15} /><span className="hidden sm:inline">تحويل</span></button>}
             </div>
           </div>}
              <div className="relative shrink-0 border-t border-stone-100 bg-white p-2 sm:p-2.5">
              {detail.readOnly && detail.canSendPrivateNote && <SecretNoteComposer text={secretNote} onTextChange={setSecretNote} recipients={privateNoteRecipients} recipientId={privateNoteRecipientId} onRecipientChange={setPrivateNoteRecipientId} sending={sendingSecretNote} onSubmit={sendSecretNote} />}
            {detail.readOnly ? <div className="pt-3 text-center text-xs text-stone-500">للقراءة فقط · لا يمكن إرسال رد للعميل أو تعديل المحادثة.</div> : <>
             {!metaWindowOpen && detail.channel === "MESSENGER" && <div className="mb-3 rounded-xl border border-red-100 bg-red-50 p-3 text-[10px] leading-5 text-red-700">انتهت نافذة رد Messenger. يجب أن يرسل العميل رسالة جديدة قبل استئناف الردود الحرة.</div>}
               {recording && <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2"><span className="flex items-center gap-2 text-xs font-bold text-red-700"><span className="h-2 w-2 animate-pulse rounded-full bg-red-600"/>تسجيل جارٍ · {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")}</span><div className="flex gap-2"><button type="button" onClick={cancelRecording} className="rounded-lg bg-white px-3 py-2 text-[10px] font-bold text-stone-600">إلغاء</button><button type="button" onClick={sendRecording} className="rounded-lg bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white">إرسال التسجيل</button></div></div>}
               {failedRecording && failedRecording.conversationId === detail.id && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2"><span className="text-[10px] font-bold text-amber-900">لم يُرسل التسجيل بعد؛ احتفظنا به لتتمكن من المحاولة مجددًا.</span><audio controls src={failedRecording.previewUrl} className="h-8 max-w-full" /><button type="button" disabled={sending || privateNoteMode} onClick={retryFailedRecording} className="rounded-lg bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white disabled:opacity-50">إعادة الإرسال</button><button type="button" onClick={() => setFailedRecording(null)} className="rounded-lg bg-white px-3 py-2 text-[10px] font-bold text-stone-600">إزالة</button></div>}
               {!privateNoteMode && replyingTo && <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[10px] text-amber-900"><ReplyIcon size={14} /><span className="min-w-0 flex-1 truncate">رد على: {replyingTo.text || (replyingTo.kind === "IMAGE" ? "صورة" : "رسالة مرفقة")}</span><button type="button" onClick={() => setReplyingTo(null)} className="rounded-md px-2 py-1 font-bold hover:bg-amber-100">إلغاء</button></div>}
             {showPlusMenu && <div ref={plusMenuRef} role="menu" aria-label="إضافة إلى الرسالة" className="soft-scroll plus-menu absolute bottom-[calc(4rem+16px)] right-3 z-20 max-h-[min(70vh,440px)] w-[min(320px,calc(100%-24px))] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-2xl">
                <div className="grid grid-cols-2 gap-1">
                  <button type="button" role="menuitem" disabled={detail.channel === "MESSENGER"} title={detail.channel === "MESSENGER" ? "الملصقات غير مدعومة في Messenger" : "اختر ملصقًا سابقًا أو ارفع ملف WebP"} onClick={() => { setShowPlusMenu(false); setShowStickerPicker(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-40"><Smile size={15} className="text-pink-700" /> الملصقات</button>
                  <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); photoInputRef.current?.click(); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-emerald-50"><ImageIcon size={15} className="text-emerald-700" /> الصور</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); cameraInputRef.current?.click(); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-emerald-50"><Camera size={15} className="text-emerald-700" /> الكاميرا</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); shareLocation(); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-emerald-50"><MapPin size={15} className="text-emerald-700" /> الموقع الحالي</button>
                 <button type="button" role="menuitem" disabled={detail.channel !== "WHATSAPP"} title={detail.channel !== "WHATSAPP" ? "بطاقة جهة الاتصال متاحة عبر WhatsApp فقط" : undefined} onClick={() => { setShowPlusMenu(false); setContactQuery(""); setContactResults([]); setShowContactCard(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"><BookUser size={15} className="text-sky-700" /> جهة اتصال</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); uploadInputRef.current?.click(); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-stone-50"><FileText size={15} className="text-stone-500" /> مستند أو ملف</button>
                 <button type="button" role="menuitem" disabled={detail.channel === "MESSENGER" || sendingPoll} onClick={() => { setShowPlusMenu(false); setShowPollComposer(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"><ListChecks size={15} className="text-sky-700" /> استطلاع</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); setShowEventComposer(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-amber-50"><CalendarDays size={15} className="text-amber-700" /> مناسبة</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); setShowAiImageComposer(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-violet-50"><Sparkles size={15} className="text-violet-700" /> صورة بالذكاء الاصطناعي</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); setShowProducts(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-amber-50"><CakeSlice size={15} className="text-amber-700" /> إرسال منتج</button>
                 <button type="button" role="menuitem" onClick={() => { setShowPlusMenu(false); setShowQuickReplyManager(true); }} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-right text-[11px] font-bold text-stone-700 hover:bg-emerald-50"><MessageCircle size={15} className="text-emerald-700" /> إدارة الردود السريعة</button>
                </div>
              </div>}
               {showStickerPicker && <div ref={stickerPickerRef} role="dialog" aria-label="اختيار ملصق" className="soft-scroll absolute bottom-[calc(4rem+16px)] right-3 z-30 max-h-[min(70vh,380px)] w-[min(360px,calc(100%-24px))] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-3 shadow-2xl">
                <div className="mb-2 flex items-center justify-between"><b className="flex items-center gap-2 text-xs"><Smile size={15} className="text-pink-700" /> ملصقات المحادثة</b><button type="button" onClick={() => setShowStickerPicker(false)} aria-label="إغلاق الملصقات" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><X size={15} /></button></div>
                {savedStickers.length ? <div className="grid grid-cols-3 gap-2">{savedStickers.map((sticker: AnyRecord) => <div key={sticker.id} className="min-w-0 rounded-xl border border-stone-100 bg-[#fafaf8] p-2"><ProtectedMedia conversationId={detail.id} message={sticker} /><button type="button" disabled={sending || !messagingEnabled} onClick={() => void sendSavedSticker(sticker)} className="mt-1 min-h-8 w-full rounded-lg bg-emerald-700 px-2 text-[9px] font-bold text-white disabled:opacity-40">إرسال</button></div>)}</div> : <p className="rounded-xl bg-stone-50 px-3 py-4 text-center text-[10px] leading-5 text-stone-500">لا توجد ملصقات WebP محفوظة في هذه المحادثة بعد.</p>}
                <button type="button" disabled={sending || !messagingEnabled} onClick={() => { setShowStickerPicker(false); stickerInputRef.current?.click(); }} className="mt-2 flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-pink-200 bg-pink-50 px-3 text-[10px] font-bold text-pink-800 disabled:opacity-40"><Plus size={13} /> اختيار ملف ملصق WebP</button>
                {detail.channel === "WHATSAPP" && <p className="mt-2 text-[9px] leading-4 text-stone-400">يتطلب إرسال ملصق WhatsApp اتصال Baileys؛ سيعرض النظام تنبيهًا إذا كان وضع الاتصال الحالي لا يدعمه.</p>}
               </div>}
                {showEmojiPicker && <div ref={emojiPickerRef} role="dialog" aria-label="اختيار إيموجي" className="absolute bottom-[calc(4rem+16px)] right-3 z-30 w-[min(320px,calc(100%-24px))] rounded-2xl border border-stone-200 bg-white p-3 shadow-2xl"><div className="mb-2 flex items-center justify-between"><b className="text-xs">الإيموجي</b><button type="button" onClick={() => setShowEmojiPicker(false)} aria-label="إغلاق الإيموجي" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"><X size={15} /></button></div><div className="grid grid-cols-6 gap-1">{commonReplyEmojis.map((emoji) => <button key={emoji} type="button" onClick={() => { setText((current) => `${current}${emoji}`); setShowEmojiPicker(false); requestAnimationFrame(() => replyInputRef.current?.focus()); }} className="grid h-10 place-items-center rounded-lg text-xl hover:bg-amber-50">{emoji}</button>)}</div></div>}
               {showCanned && <div role="listbox" aria-label="الردود الجاهزة" className="soft-scroll absolute bottom-[calc(4rem+16px)] right-3 z-10 max-h-60 w-[min(340px,calc(100%-24px))] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-xl">{filteredCanned.map((reply, index) => <button key={reply.id} type="button" role="option" aria-selected={index === cannedReplyIndex} onMouseEnter={() => setCannedReplyIndex(index)} onClick={() => chooseCannedReply(reply)} className={`flex w-full flex-col rounded-xl px-3 py-2 text-right ${index === cannedReplyIndex ? "bg-[#fff8e9]" : "hover:bg-[#fff8e9]"}`}><b className="text-xs text-[#b71c1c]">{reply.shortcut} <span className="font-medium text-stone-500">· {reply.title}</span></b><span className="mt-1 line-clamp-2 text-[10px] leading-5 text-stone-400">{reply.content}</span></button>)}{!filteredCanned.length && <p className="px-3 py-4 text-xs text-stone-400">لا يوجد رد مطابق</p>}</div>}
               {pendingQuickReply && !privateNoteMode && <div className="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-[10px] text-emerald-900"><span className="min-w-0 flex-1 truncate">رد سريع {pendingQuickReply.shortcut}{pendingQuickReply.mediaAsset?.fileName ? ` · ${pendingQuickReply.mediaAsset.fileName}` : ""}{pendingQuickReply.tagIds?.length ? ` · ستُضاف ${pendingQuickReply.tagIds.length} قائمة` : ""}</span><button type="button" aria-label="إلغاء الرد السريع" onClick={() => setPendingQuickReply(null)} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-white"><X size={14} /></button></div>}
                <form onSubmit={(event) => { if (privateNoteMode) void sendSecretNote(event); else sendReply(event); }}>
                  <div className={`overflow-hidden rounded-xl border bg-white focus-within:shadow-[0_0_0_3px_rgba(211,47,47,.05)] ${privateNoteMode ? "border-violet-200 focus-within:border-violet-300" : "border-stone-200 focus-within:border-[#e4b8a8]"}`}>
                    {privateNoteMode && <div className="flex min-h-10 items-center gap-2 border-b border-violet-100 bg-violet-50/70 px-3">
                      <LockKeyhole size={14} className="shrink-0 text-violet-700" />
                      <span className="shrink-0 text-[10px] font-bold text-violet-900">إلى</span>
                      <select aria-label="الزميل المستلم" value={privateNoteRecipientId} onChange={(event) => setPrivateNoteRecipientId(event.target.value)} disabled={!privateNoteRecipients.length || sendingSecretNote} className="min-w-0 flex-1 bg-transparent py-2 text-[11px] text-violet-950 outline-none disabled:text-stone-400">
                        <option value="">{privateNoteRecipients.length ? "اختر الزميل" : "لا يوجد زملاء مؤهّلون"}</option>
                        {privateNoteRecipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name}{recipient.presence ? ` · ${privateNotePresenceLabels[recipient.presence] || "غير متصل"}` : ""}</option>)}
                      </select>
                      <span className="hidden shrink-0 text-[9px] text-violet-600 sm:inline">لا يراها العميل</span>
                    </div>}
                    <textarea ref={replyInputRef} rows={1} maxLength={privateNoteMode ? 4000 : undefined} value={privateNoteMode ? secretNote : text} disabled={privateNoteMode ? sendingSecretNote : !messagingEnabled} onChange={(event) => { if (privateNoteMode) setSecretNote(event.target.value); else { setText(event.target.value); setShowCanned(event.target.value.startsWith("/")); } }} onPaste={(event) => { if (privateNoteMode) return; const images = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/" )).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)); if (!images.length) return; event.preventDefault(); void uploadSelectedFiles(images.map((file, index) => file.name ? file : new File([file], `pasted-image-${Date.now()}-${index}.png`, { type: file.type || "image/png" }))); }} onKeyDown={(event) => { if (!privateNoteMode && event.key === "ArrowUp" && !showCanned && !text.trim() && recallLastSentMessage()) { event.preventDefault(); return; } if (event.key === "Enter" && !event.shiftKey && (!showCanned || privateNoteMode)) { event.preventDefault(); if (privateNoteMode) void sendSecretNote(); else void submitReply(); } }} placeholder={privateNoteMode ? "اكتب رسالة سرية لا يراها العميل..." : detail.customer?.isBlocked ? "العميل محظور داخل النظام" : metaWindowOpen ? "اكتب ردك هنا أو الصق صورة... اكتب / للردود الجاهزة" : "الرد الحر مقفل حتى يرد العميل"} className="max-h-28 min-h-[44px] w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-[13px] leading-5 outline-none placeholder:text-stone-300 disabled:cursor-not-allowed disabled:bg-stone-50" />
                    <div className="flex items-center justify-between gap-2 border-t border-stone-100 px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        {detail.canSendPrivateNote && <button type="button" aria-label={privateNoteMode ? "إيقاف وضع الرسالة السرية" : "إرسال رسالة سرية لزميل"} aria-pressed={privateNoteMode} title={privateNoteMode ? "رسالة سرية لزميل" : "تبديل إلى رسالة سرية"} disabled={sending || sendingSecretNote || recording || requestingRecording} onClick={() => { setPrivateNoteMode((mode) => !mode); setShowCanned(false); setShowPlusMenu(false); }} className={`grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40 ${privateNoteMode ? "bg-violet-100 text-violet-800" : "text-stone-500 hover:bg-violet-50 hover:text-violet-700"}`}><LockKeyhole size={16} /></button>}
                         <button type="button" disabled={privateNoteMode || !metaWindowOpen || sending || requestingRecording} title={privateNoteMode ? "التسجيل الصوتي متاح لردود العميل فقط" : recording ? "إيقاف التسجيل وإرساله" : requestingRecording ? "جارٍ طلب إذن الميكروفون" : "تسجيل رسالة صوتية"} onClick={() => void toggleRecording()} className={`grid h-8 w-8 place-items-center rounded-lg ${recording ? "bg-red-50 text-red-600" : "text-stone-500 hover:bg-stone-100"} disabled:opacity-40`}>{recording ? <MicOff size={16} /> : <Mic size={16} />}</button>
                         <button type="button" aria-label="اختيار ملصق" title={detail.channel === "MESSENGER" ? "الملصقات غير مدعومة في Messenger" : "إرسال أو رفع ملصق WebP"} disabled={privateNoteMode || detail.channel === "MESSENGER" || !messagingEnabled || sending} onClick={() => { setShowPlusMenu(false); setShowCanned(false); setShowStickerPicker(true); }} className="grid h-8 w-8 place-items-center rounded-lg text-pink-700 hover:bg-pink-50 disabled:opacity-40"><Smile size={16} /></button>
                         <button ref={emojiButtonRef} type="button" aria-label="اختيار إيموجي" title="إدراج إيموجي في الرسالة" aria-expanded={showEmojiPicker} aria-haspopup="dialog" disabled={privateNoteMode || !messagingEnabled || sending} onClick={() => { setShowStickerPicker(false); setShowPlusMenu(false); setShowCanned(false); setShowEmojiPicker((shown) => !shown); }} className="grid h-8 w-8 place-items-center rounded-lg text-amber-700 hover:bg-amber-50 disabled:opacity-40">😊</button>
                        <button ref={plusButtonRef} type="button" aria-label="إضافة مرفق أو إجراء" aria-haspopup="menu" aria-expanded={showPlusMenu} disabled={privateNoteMode || !messagingEnabled || sending} onClick={() => { setShowCanned(false); setShowPlusMenu((shown) => !shown); }} className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40"><Plus size={17} /></button>
                      </div>
                      <button type="submit" disabled={privateNoteMode ? (!secretNote.trim() || !privateNoteRecipientId || !privateNoteRecipients.some((recipient) => recipient.id === privateNoteRecipientId) || sendingSecretNote) : ((!text.trim() && !pendingQuickReply?.mediaAssetId) || !messagingEnabled || sending)} className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-bold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${privateNoteMode ? "bg-violet-700 hover:bg-violet-800" : "bg-[#d32f2f] shadow-red-200 hover:bg-[#b71c1c]"}`}><span>{privateNoteMode ? sendingSecretNote ? "جارٍ الإرسال..." : "إرسال سري" : sending ? "جارٍ الإرسال" : "إرسال"}</span><Send size={14} /></button>
                    </div>
                  </div>
                </form><p className="mt-1 text-center text-[9px] text-stone-400">Enter للإرسال · Shift + Enter لسطر جديد · رسائل العملاء تمر عبر القناة الأصلية</p>
            </>}
            </div>
        </> : activeId ? <div className="grid flex-1 place-items-center text-xs text-stone-400">جارٍ تحميل المحادثة...</div> : <div className="grid flex-1 place-items-center text-center"><div><div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-[#fff2dd] text-[#c38f22]"><MessageCircle size={28} /></div><h2 className="mt-4 font-extrabold">اختر محادثة للبدء</h2><p className="mt-1 text-xs text-stone-400">ستظهر لك الرسائل وتفاصيل العميل هنا.</p></div></div>}
      </section>

       <aside className={`workspace-profile panel soft-scroll flex min-h-0 flex-col gap-4 overflow-y-auto p-4 ${showMobileProfile ? "workspace-profile-open" : ""} ${showCustomerSidebar ? "" : "workspace-profile-collapsed"}`}>
         {detail ? <>
             <button type="button" onClick={closeCustomerProfile} aria-label="إغلاق ملف العميل" className="flex min-h-8 shrink-0 items-center gap-1 self-start rounded-lg px-2 text-[10px] font-bold text-stone-500 hover:bg-stone-100"><X size={14} /> إغلاق الملف</button>
            <div inert={Boolean(detail.readOnly)} className="contents">
           <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-extrabold">ملف العميل</h2><div className="flex items-center gap-1"><button type="button" onClick={() => void togglePin()} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold ${pinnedIds.includes(activeId) ? "bg-blue-50 text-blue-700" : "text-stone-400 hover:bg-stone-100"}`} aria-label={pinnedIds.includes(activeId) ? "إلغاء تثبيت المحادثة" : "تثبيت المحادثة"}><Pin size={14} />{pinnedIds.includes(activeId) ? "مثبتة" : "تثبيت"}</button><button type="button" onClick={() => void toggleCustomerFavorite()} disabled={savingCustomerFavorite} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold disabled:opacity-50 ${favoriteCustomerIds.includes(detail.customer?.id) ? "bg-amber-50 text-amber-700" : "text-stone-400 hover:bg-stone-100"}`} aria-label={favoriteCustomerIds.includes(detail.customer?.id) ? "إزالة العميل من المفضلة" : "حفظ العميل في المفضلة"}><Star size={14} fill={favoriteCustomerIds.includes(detail.customer?.id) ? "currentColor" : "none"} />{favoriteCustomerIds.includes(detail.customer?.id) ? "مفضل" : "حفظ العميل"}</button></div></div>
           <div className="rounded-2xl bg-[#fff8e9] p-4 text-center"><AvatarLarge name={customerDisplayName(detail.customer)} src={detail.customer?.avatarUrl} /><h3 className="mt-3 font-extrabold">{customerDisplayName(detail.customer)}</h3><p className="mt-1 text-[10px] text-stone-400">عميل منذ {formatCairoDateTime(detail.customer?.createdAt || detail.createdAt, false)}</p><div className="mt-3 flex justify-center gap-2"><a href={detail.customer?.phone ? `tel:${String(detail.customer.phone).replace(/[^0-9+*#;]/g, "")}` : undefined} aria-label="الاتصال بالعميل" title="الاتصال بالعميل" className={`grid h-9 w-9 place-items-center rounded-xl bg-white ${detail.customer?.phone ? "text-stone-500 hover:bg-emerald-50 hover:text-emerald-700" : "pointer-events-none text-stone-300"}`}><Phone size={15} /></a><button type="button" onClick={() => replyInputRef.current?.focus()} aria-label="إرسال رسالة للعميل" title="الانتقال إلى مربع الرد" className="grid h-9 w-9 place-items-center rounded-xl bg-white text-stone-500 hover:bg-amber-50 hover:text-amber-700"><MessageCircle size={15} /></button></div></div>
            {detail.channel === "WHATSAPP" && !isWhatsAppGroupConversation(detail) && <button type="button" disabled={detail.customer?.isBlocked || !callTarget || Boolean(callConversation)} onClick={() => setCallConversation(detail)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-3 py-2.5 text-xs font-extrabold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"><PhoneCall size={16} />{callConversation ? "أنه المكالمة الحالية أولًا" : "مكالمة WhatsApp داخل النظام"}</button>}
            <div className="grid grid-cols-2 gap-2"><button type="button" disabled={savingCustomerFlags} onClick={() => void toggleCustomerFlag("isVip")} className={`rounded-xl px-3 py-2 text-[10px] font-bold disabled:opacity-50 ${detail.customer?.isVip ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600 hover:bg-amber-50"}`}>{detail.customer?.isVip ? "VIP · إزالة التمييز" : "تمييز العميل VIP"}</button><button type="button" disabled={savingCustomerFlags} onClick={() => void toggleCustomerFlag("isBlocked")} className={`flex items-center justify-center gap-1 rounded-xl px-3 py-2 text-[10px] font-bold disabled:opacity-50 ${detail.customer?.isBlocked ? "bg-red-100 text-red-800" : "bg-stone-100 text-stone-600 hover:bg-red-50 hover:text-red-700"}`}><Ban size={13} />{detail.customer?.isBlocked ? "إلغاء الحظر" : "حظر داخل النظام"}</button></div>
              <div className="grid grid-cols-2 gap-2"><Info label="الهاتف" value={displayPhoneNumber(detail.customer?.phone)} /><Info label="القناة" value={channelName(detail.channel)} /></div>
              <CopyableCustomerIdentities customer={detail.customer} channel={detail.channel} externalCustomerId={detail.externalCustomerId} />
            <form onSubmit={saveCustomerProfile} className="space-y-3 rounded-2xl border border-stone-100 bg-white p-3">
              <label className="block text-[10px] font-bold text-stone-500">اسم العميل<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">رقم الهاتف<input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} maxLength={32} dir="ltr" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">البريد الإلكتروني<input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} maxLength={254} dir="ltr" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label>
              <label className="block text-[10px] font-bold text-stone-500">ملاحظات سريعة<textarea value={customerNotes} onChange={(event) => setCustomerNotes(event.target.value)} maxLength={4000} rows={3} placeholder="مثال: يفضل التواصل مساءً" className="mt-1 w-full resize-y rounded-lg border border-stone-200 px-2 py-2 text-xs font-normal leading-5 text-stone-700 outline-none focus:border-amber-300" /></label>
              <button type="submit" disabled={savingCustomer} className="h-9 w-full rounded-lg bg-[#d32f2f] text-xs font-bold text-white disabled:opacity-60">{savingCustomer ? "جارٍ الحفظ..." : "حفظ بيانات العميل"}</button>
            </form>
            <form onSubmit={addInternalNote} className="space-y-2 rounded-2xl border border-blue-100 bg-blue-50/60 p-3"><label className="block text-[10px] font-bold text-blue-900">ملاحظة داخلية للفريق<textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} maxLength={4000} rows={2} placeholder="تظهر لموظفي الفريق فقط، ولا ترسل للعميل" className="mt-1 w-full resize-y rounded-lg border border-blue-100 bg-white px-2 py-2 text-xs font-normal leading-5 text-stone-700 outline-none focus:border-blue-300" /></label><button disabled={!internalNote.trim()} className="h-9 w-full rounded-lg bg-blue-800 text-xs font-bold text-white disabled:opacity-40">إضافة ملاحظة داخلية</button></form>
           <div className="flex items-center justify-between rounded-xl border border-[#f0e7d6] bg-[#fffdf7] px-3 py-2"><div><b className="text-[11px]">أمر تحضير</b><p className="text-[9px] text-stone-400">احفظ الطلب ثم اطبعه أو صدّره PDF</p></div><button type="button" onClick={printOrder} className="flex items-center gap-1 rounded-lg bg-[#d32f2f] px-2.5 py-2 text-[9px] font-bold text-white"><Printer size={13} /> طباعة</button></div>
             <div className="grid grid-cols-2 gap-2"><label className="block text-[10px] font-bold text-stone-500">الإجمالي بالجنيه<input type="number" min="0" step="0.01" value={order.price} onChange={(e) => setOrder({ ...order, price: e.target.value })} placeholder="اختياري" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">قيمة العربون<input type="number" min="0" max={order.price || undefined} step="0.01" value={order.deposit} onChange={(e) => setOrder({ ...order, deposit: e.target.value })} placeholder="0.00" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label></div><p className="rounded-lg bg-emerald-50 px-3 py-2 text-[10px] font-bold text-emerald-800">المتبقي للدفع: {Math.max(0, Number(order.price || 0) - Number(order.deposit || 0)).toFixed(2)} ج.م</p>
          <div className="border-t border-stone-100 pt-3"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-extrabold">طلب حلويات جديد</h3><span className="rounded-full bg-amber-50 px-2 py-1 text-[9px] font-bold text-amber-700">مسودة</span></div><form onSubmit={saveOrder} className="space-y-2.5"><label className="block text-[10px] font-bold text-stone-500">الصنف<input value={order.product} onChange={(e) => setOrder({ ...order, product: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal text-stone-700 outline-none focus:border-amber-300" /></label><div className="grid grid-cols-2 gap-2"><label className="text-[10px] font-bold text-stone-500">الحجم<input value={order.size} onChange={(e) => setOrder({ ...order, size: e.target.value })} placeholder="مثال: 2 كجم" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="text-[10px] font-bold text-stone-500">الحشوة<input value={order.filling} onChange={(e) => setOrder({ ...order, filling: e.target.value })} placeholder="شوكولاتة" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label></div><label className="block text-[10px] font-bold text-stone-500">العبارة على التورتة<input value={order.cakeMessage} onChange={(e) => setOrder({ ...order, cakeMessage: e.target.value })} placeholder="كل عام وأنت بخير" className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">موعد التسليم<input type="datetime-local" value={order.deliveryAt} onChange={(e) => setOrder({ ...order, deliveryAt: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-[10px] font-normal outline-none" /></label><label className="block text-[10px] font-bold text-stone-500">عنوان التوصيل<input value={order.deliveryAddress} onChange={(e) => setOrder({ ...order, deliveryAddress: e.target.value })} placeholder="المدينة، الشارع..." className="mt-1 h-9 w-full rounded-lg border border-stone-200 px-2 text-xs font-normal outline-none" /></label><button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#d32f2f] text-xs font-bold text-white hover:bg-[#b71c1c]"><Check size={14} /> حفظ الطلب</button></form></div>
          {!!detail.customer?.orders?.length && <div className="border-t border-stone-100 pt-3"><h3 className="mb-2 text-xs font-extrabold">آخر الطلبات</h3>{detail.customer.orders.slice(0, 3).map((item: AnyRecord) => <div key={item.id} className="mb-2 rounded-xl bg-stone-50 px-3 py-2 text-[10px]"><div className="font-bold">{item.product || "طلب حلويات"}</div><div className="mt-1 flex items-center justify-between gap-2 text-stone-400"><span>{orderStatus(item.status)} · {ago(item.createdAt)}</span>{item.status !== "DELIVERED" && item.status !== "COMPLETED" && item.status !== "CANCELLED" && <select aria-label="تحديث حالة الطلب" value={item.status} onChange={(e) => updateOrderStatus(item.id, e.target.value)} className="max-w-32 rounded-lg border border-stone-200 bg-white px-2 py-1 font-bold text-[#b71c1c]"><option value="DRAFT">مسودة</option><option value="CONFIRMED">مؤكد</option><option value="PREPARING">قيد التجهيز</option><option value="OUT_FOR_DELIVERY">خرج للتوصيل</option><option value="DELIVERED">تم التسليم</option><option value="CANCELLED">إلغاء الطلب</option></select>}</div></div>)}</div>}
            {!!detail.whatsappCallSessions?.length && <section className="border-t border-stone-100 pt-3"><h3 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold"><PhoneCall size={14} /> سجل المكالمات</h3><div className="space-y-2">{detail.whatsappCallSessions.map((call: AnyRecord) => <div key={call.id} className="rounded-xl bg-stone-50 px-3 py-2 text-[10px]"><div className="flex items-center justify-between gap-2"><b>{call.direction === "INCOMING" ? "مكالمة واردة" : "مكالمة صادرة"}</b><span className="text-stone-500">{callStatusLabel(call.status)}</span></div><div className="mt-1 flex items-center justify-between gap-2 text-stone-400"><span>{formatCairoDateTime(call.createdAt)}</span>{call.endedAt && <span>انتهت {formatCairoTime(call.endedAt)}</span>}</div><div className="mt-1 text-[9px] text-stone-400">{call.transport === "INTERNAL_WEB" ? "اتصال داخل النظام" : "WhatsApp"}{call.recording ? " · التسجيل محفوظ ضمن التقارير المصرح بها" : ""}</div></div>)}</div></section>}
           <div className="mt-auto flex items-center gap-2 rounded-xl border border-dashed border-stone-200 p-3 text-[10px] leading-5 text-stone-400"><Clock3 size={16} className="shrink-0" /> بيانات العميل وطلباته محفوظة بشكل آمن ضمن سجل المحادثة.</div>
           </div>
        </> : <div className="grid flex-1 place-items-center text-center text-xs text-stone-400"><div><UserRound size={25} className="mx-auto text-stone-300" /><p className="mt-2">ملف العميل سيظهر هنا</p></div></div>}
      </aside>
    </section>
      {incomingCall && <IncomingWhatsAppCallModal call={incomingCall} onReject={rejectIncomingWhatsAppCall} onOpenConversation={openIncomingCallConversation} onDismiss={() => setIncomingCall(null)} />}
      {callConversation && <WhatsAppCallModal conversationId={callConversation.id} customerName={customerDisplayName(callConversation.customer)} phone={callConversation.customer?.phone || callConversation.externalCustomerId || ""} socket={socket} onClose={() => setCallConversation(null)} />}
      {imageEditor && <ImageEditorDialog file={imageEditor.file} url={imageEditor.url} onCancel={() => finishImageEditor(null)} onComplete={finishImageEditor} />}
      {lightboxImage && <div role="dialog" aria-modal="true" aria-label="معاينة الصورة" onClick={() => setLightboxImage("")} className="fixed inset-0 z-[70] grid place-items-center bg-black/90 p-4"><button type="button" aria-label="إغلاق معاينة الصورة" onClick={() => setLightboxImage("")} className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/15 text-2xl text-white hover:bg-white/25">×</button><img src={lightboxImage} alt="معاينة مكبرة" onClick={(event) => event.stopPropagation()} className="max-h-[88vh] max-w-[94vw] rounded-lg object-contain shadow-2xl" /></div>}
     {showContacts && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowContacts(false)}><section role="dialog" aria-modal="true" aria-labelledby="contacts-title" className="panel flex max-h-[85vh] w-full max-w-lg flex-col p-5" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="contacts-title" className="text-base font-extrabold">جهات الاتصال</h2><p className="mt-1 text-xs text-stone-500">اختر اسمًا لفتح محادثة WhatsApp داخل النظام.</p></div><button type="button" onClick={() => setShowContacts(false)} aria-label="إغلاق جهات الاتصال" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><label className="mb-3 flex h-10 items-center gap-2 rounded-xl bg-stone-50 px-3"><Search size={15} className="text-stone-400" /><input autoFocus value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="ابحث بالاسم أو رقم الهاتف" className="w-full bg-transparent text-xs outline-none" /></label><div className="soft-scroll min-h-32 flex-1 overflow-y-auto">{loadingContacts ? <p className="py-8 text-center text-xs text-stone-400">جارٍ البحث...</p> : contactResults.map((contact) => <button key={contact.id} type="button" disabled={!contact.phone} onClick={() => void startChatFromContact(contact)} className="flex w-full items-center gap-3 border-b border-stone-100 px-2 py-3 text-right hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"><Avatar name={customerDisplayName(contact)} src={contact.avatarUrl} /><span className="min-w-0 flex-1"><b className="block truncate text-xs">{customerDisplayName(contact)}</b><span dir="ltr" className="mt-1 block text-right text-[10px] text-stone-400">{contact.phone || "أضف رقم هاتف لبدء محادثة"}</span></span><MessageCircle size={16} className="text-emerald-700" /></button>)}{!loadingContacts && !contactResults.length && <p className="py-8 text-center text-xs text-stone-400">لا توجد جهة اتصال مطابقة.</p>}</div><p className="mt-3 text-[9px] leading-4 text-stone-400">في وضع WhatsApp Business API قد يتطلب بدء مراسلة جديدة استخدام قالب معتمد من Meta.</p></section></div>}
     {forwardMessage && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => { setForwardMessage(null); setForwardQuery(""); }}><section role="dialog" aria-modal="true" aria-labelledby="forward-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="forward-title" className="text-base font-extrabold">تحويل الرسالة</h2><p className="mt-1 text-xs leading-5 text-stone-500">ستُرسل نسخة من الرسالة إلى محادثة أخرى.</p></div><button type="button" onClick={() => { setForwardMessage(null); setForwardQuery(""); }} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><input autoFocus value={forwardQuery} onChange={(event) => setForwardQuery(event.target.value)} placeholder="ابحث عن محادثة" className="mb-3 h-10 w-full rounded-xl border border-stone-200 px-3 text-xs outline-none focus:border-amber-400" /><div className="max-h-[55vh] space-y-2 overflow-y-auto">{conversations.filter((item) => item.id !== forwardMessage.conversationId && customerDisplayName(item.customer).toLocaleLowerCase().includes(forwardQuery.trim().toLocaleLowerCase())).map((target) => <button key={target.id} type="button" onClick={() => void forwardMessageTo(target)} className="flex w-full items-center gap-3 rounded-xl border border-stone-100 bg-white p-3 text-right hover:border-amber-200 hover:bg-amber-50"><Avatar name={customerDisplayName(target.customer)} src={target.customer?.avatarUrl} /><span className="min-w-0 flex-1"><b className="block truncate text-xs">{customerDisplayName(target.customer)}</b><span className="mt-1 flex items-center gap-1.5 text-[10px] text-stone-400"><ChannelIcon channel={target.channel} />{channelName(target.channel)}</span></span><Forward size={15} className="text-stone-400" /></button>)}{!conversations.some((item) => item.id !== forwardMessage.conversationId && customerDisplayName(item.customer).toLocaleLowerCase().includes(forwardQuery.trim().toLocaleLowerCase())) && <p className="rounded-xl bg-stone-50 p-5 text-center text-xs text-stone-500">لا توجد محادثات مطابقة ضمن المحادثات المحمّلة.</p>}</div></section></div>}
      {showHandoff && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowHandoff(false)}><section role="dialog" aria-modal="true" aria-labelledby="handoff-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="handoff-title" className="text-base font-extrabold">تحويل المحادثة لزميل متاح</h2><p className="mt-1 text-xs leading-5 text-stone-500">اختر زميلًا متصلًا لديه صلاحية على {channelName(detail?.channel || "")}. تبقى المحادثة لديك حتى يقبلها؛ وإذا رفضها، تعود إليك لتتابعها أو تحولها لزميل آخر.</p></div><button type="button" onClick={() => setShowHandoff(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div>{handoffError && handoffError.conversationId === activeId && <div role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700"><p>{handoffError.message}</p>{!handoffColleagues.length && !loadingHandoffColleagues && <button type="button" onClick={() => void openHandoffDialog()} className="mt-1 font-bold underline">إعادة تحميل الزملاء</button>}</div>}<div className="max-h-[55vh] space-y-2 overflow-y-auto">{loadingHandoffColleagues ? <p role="status" className="rounded-xl bg-stone-50 p-5 text-center text-xs text-stone-500">جارٍ تحميل الزملاء...</p> : <>{handoffColleagues.map((colleague) => <button key={colleague.id} type="button" disabled={Boolean(handoffBusyId)} onClick={() => void handoffToColleague(colleague.id, colleague.name)} className="flex w-full items-center gap-3 rounded-xl border border-stone-100 bg-white p-3 text-right hover:border-amber-200 hover:bg-amber-50 disabled:opacity-60"><Avatar name={colleague.name} /><span className="min-w-0 flex-1"><b className="block truncate text-sm">{colleague.name}</b><span className="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" /> متاح الآن</span></span><span className="rounded-lg bg-[#d32f2f] px-3 py-2 text-[10px] font-bold text-white">{handoffBusyId === colleague.id ? "جارٍ التحويل..." : "تحويل"}</span></button>)}{!handoffColleagues.length && !handoffError && <div className="rounded-xl bg-stone-50 p-5 text-center text-xs leading-6 text-stone-500">لا يوجد زميل مؤهل ومتاح لهذه المحادثة الآن. جرّب لاحقًا أو أبقِها لديك.</div>}</>}</div></section></div>}
    {showProducts && <div className="fixed inset-0 z-40 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => { setShowProducts(false); setSelectedProductIds([]); }}><section role="dialog" aria-modal="true" aria-labelledby="products-title" className="panel max-h-[90vh] w-full max-w-4xl overflow-y-auto p-4 sm:p-6" onClick={(event) => event.stopPropagation()}>
       <div className="mb-4 flex items-center justify-between gap-3"><div><h2 id="products-title" className="text-lg font-extrabold">كتالوج حلواني بندق</h2><p className="text-xs text-stone-400">حدد منتجًا واحدًا أو أكثر لإرسال السعر والصورة معًا</p></div><button type="button" aria-label="إغلاق الكتالوج" onClick={() => { setShowProducts(false); setSelectedProductIds([]); }} className="rounded-lg px-3 py-1 text-xl text-stone-400">×</button></div>
       <label className="mb-3 flex h-10 items-center gap-2 rounded-xl border border-stone-200 bg-white px-3"><Search size={15} className="text-stone-400" /><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="ابحث باسم المنتج أو الكود" className="w-full bg-transparent text-xs outline-none" /></label>
       <div className="soft-scroll mb-4 flex gap-2 overflow-x-auto pb-1">{[{ id: "ALL", label: "الكل" }, { id: "EASTERN", label: "شرقي" }, { id: "WESTERN", label: "غربي" }, { id: "CAKES", label: "تورتات" }, { id: "BAKERY", label: "مخبوزات" }, { id: "KAHK", label: "كحك وبسكويت" }, { id: "CHOCOLATE", label: "شوكولاتة" }, { id: "MOULID", label: "حلاوة المولد" }, { id: "OCCASIONS", label: "مناسبات" }, { id: "MIX_BONDOQ", label: "ميكس بندق" }].filter((item) => item.id === "ALL" || products.some((product) => product.category === item.id)).map((item) => <button type="button" key={item.id} onClick={() => setProductFilter(item.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${productFilter === item.id ? "bg-[#d32f2f] text-white" : "bg-stone-100 text-stone-500"}`}>{item.label}</button>)}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleProducts.map((product) => {
        const isSelected = selectedProductIds.includes(product.id);
        return <article key={product.id} className={`overflow-hidden rounded-2xl border bg-white ${isSelected ? "border-[#d32f2f] ring-2 ring-red-100" : "border-stone-100"}`}>
          {product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-36 w-full object-cover" /> : <div className="grid h-36 place-items-center bg-[#fff6e5] text-[#bd8e21]"><CakeSlice size={38} /></div>}
           <div className="p-3"><div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-extrabold">{product.name}</h3><p className="mt-1 text-[10px] text-stone-400">{categoryLabel(product.category)}{product.sku ? ` · كود ${product.sku}` : ""}</p></div><b className="shrink-0 text-xs text-[#a57a1c]">{Number(product.price).toFixed(2)} ج.م</b></div>{product.description && <p className="mt-2 line-clamp-2 text-[10px] leading-5 text-stone-500">{product.description}</p>}
            <button type="button" disabled={!product.imageUrl} aria-pressed={isSelected} onClick={() => toggleProductSelection(product.id)} className={`mt-3 w-full rounded-xl px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-stone-300 ${isSelected ? "bg-stone-700" : "bg-[#d32f2f]"}`}>{!product.imageUrl ? "أضف صورة المنتج أولًا" : isSelected ? "إزالة من التحديد" : "تحديد للإرسال"}</button>
          </div>
        </article>;
      })}</div>
      {!visibleProducts.length && <div className="py-12 text-center text-sm text-stone-400">لا توجد منتجات في هذا القسم.</div>}
      <footer className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 bg-white py-3"><span className="text-xs font-semibold text-stone-500">{selectedProductIds.length ? `تم تحديد ${selectedProductIds.length} من 12 منتجًا` : "حدد المنتجات المطلوبة أولًا"}</span><button type="button" disabled={!selectedProductIds.length || sendingProducts} onClick={() => void sendSelectedProducts()} className="rounded-xl bg-[#d32f2f] px-5 py-3 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:bg-stone-300">{sendingProducts ? "جارٍ الإرسال..." : `إرسال ${selectedProductIds.length || "المنتجات المحددة"} للعميل`}</button></footer>
    </section></div>}
     {savedOrder && detail && <section className="print-ticket" dir="rtl"><h1>حلواني بندق · أمر تحضير</h1><div className="ticket-rule" /><p><b>رقم الطلب:</b> {savedOrder.id}</p><p><b>العميل:</b> {customerDisplayName(detail.customer)}</p><p><b>الهاتف:</b> {detail.customer?.phone || "غير متوفر"}</p><div className="ticket-rule" /><p><b>الصنف:</b> {savedOrder.product || "تورتة"}</p><p><b>الحجم:</b> {savedOrder.size || "—"}　 <b>الحشوة:</b> {savedOrder.filling || "—"}</p><p><b>السعر:</b> {savedOrder.price ? `${Number(savedOrder.price).toFixed(2)} جنيه مصري` : "غير محدد"}</p><p><b>العبارة:</b> {savedOrder.cakeMessage || "—"}</p><p><b>التسليم:</b> {formatCairoDateTime(savedOrder.deliveryAt)}</p><p><b>العنوان:</b> {savedOrder.deliveryAddress || "—"}</p><p><b>ملاحظات:</b> {savedOrder.notes || "—"}</p><div className="ticket-rule" /><p className="ticket-footer">يُسلّم إلى قسم الإنتاج · {formatCairoDateTime(new Date())}</p></section>}
     {showPollComposer && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowPollComposer(false)}><section role="dialog" aria-modal="true" aria-labelledby="poll-title" className="panel w-full max-w-md p-5 sm:p-6" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="poll-title" className="text-base font-extrabold">إنشاء استطلاع</h2><p className="mt-1 text-xs leading-5 text-stone-500">متاح في Telegram وWhatsApp عبر Baileys. لا يمكن تعديل الاستطلاع بعد إرساله.</p></div><button type="button" onClick={() => setShowPollComposer(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><form onSubmit={(event) => void createPoll(event)} className="space-y-3"><label className="block text-xs font-bold text-stone-600">سؤال الاستطلاع<input required maxLength={300} value={pollQuestion} onChange={(event) => setPollQuestion(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal outline-none focus:border-sky-400" /></label><label className="block text-xs font-bold text-stone-600">الخيارات <span className="font-normal text-stone-400">(خيار واحد في كل سطر)</span><textarea required rows={6} maxLength={1200} value={pollOptionsText} onChange={(event) => setPollOptionsText(event.target.value)} placeholder={'الخيار الأول\nالخيار الثاني'} className="mt-1 w-full resize-y rounded-xl border border-stone-200 px-3 py-2 text-sm font-normal leading-6 outline-none focus:border-sky-400" /></label><p className="text-[10px] leading-5 text-stone-400">أضف من خيارين إلى عشرة. التصويت والنتائج تتم في القناة الأصلية.</p><div className="flex justify-end gap-2"><button type="button" onClick={() => setShowPollComposer(false)} className="rounded-xl bg-stone-100 px-4 py-2.5 text-xs font-bold text-stone-600">إلغاء</button><button type="submit" disabled={sendingPoll || !metaWindowOpen} className="rounded-xl bg-sky-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{sendingPoll ? "جارٍ الإرسال..." : "إرسال الاستطلاع"}</button></div></form></section></div>}
      {showEventComposer && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowEventComposer(false)}><section role="dialog" aria-modal="true" aria-labelledby="event-title" className="panel w-full max-w-lg p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="event-title" className="flex items-center gap-2 text-base font-extrabold"><CalendarDays size={17} className="text-amber-700" /> مشاركة مناسبة أو موعد</h2><p className="mt-1 text-xs leading-5 text-stone-500">تُرسل تفاصيل الموعد كبطاقة نصية داخل المحادثة.</p></div><button type="button" onClick={() => setShowEventComposer(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400">×</button></div>
        <form onSubmit={(event) => void sendEventCard(event)} className="space-y-3">
          <label className="block text-xs font-bold text-stone-600">اسم المناسبة<input required maxLength={120} value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} placeholder="مثال: موعد استلام الطلب" className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal" /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold text-stone-600">وقت البداية<input required type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-2 text-xs font-normal" /></label><label className="block text-xs font-bold text-stone-600">وقت النهاية<input type="datetime-local" value={eventEndsAt} onChange={(event) => setEventEndsAt(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-2 text-xs font-normal" /></label></div>
          <label className="block text-xs font-bold text-stone-600">المكان<input maxLength={180} value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 px-3 text-sm font-normal" /></label>
          <label className="block text-xs font-bold text-stone-600">تفاصيل إضافية<textarea maxLength={500} rows={3} value={eventDetails} onChange={(event) => setEventDetails(event.target.value)} className="mt-1 w-full resize-y rounded-xl border border-stone-200 px-3 py-2 text-sm font-normal leading-6" /></label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowEventComposer(false)} className="rounded-xl bg-stone-100 px-4 py-2.5 text-xs font-bold text-stone-600">إلغاء</button><button type="submit" disabled={sending} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{sending ? "جارٍ الإرسال..." : "إرسال الموعد"}</button></div>
        </form>
      </section></div>}
      {showAiImageComposer && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => !generatingAiImage && setShowAiImageComposer(false)}><section role="dialog" aria-modal="true" aria-labelledby="ai-image-title" className="panel w-full max-w-lg p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="ai-image-title" className="flex items-center gap-2 text-base font-extrabold"><Sparkles size={17} className="text-violet-700" /> إنشاء صورة بالذكاء الاصطناعي</h2><p className="mt-1 text-xs leading-5 text-stone-500">ستُنشأ الصورة ثم تُرسل مباشرةً إلى العميل. راجع وصفك قبل الإرسال.</p></div><button type="button" disabled={generatingAiImage} onClick={() => setShowAiImageComposer(false)} aria-label="إغلاق" className="rounded-lg p-1 text-xl text-stone-400 disabled:opacity-40">×</button></div>
        <form onSubmit={(event) => void generateAndSendAiImage(event)} className="space-y-3"><label className="block text-xs font-bold text-stone-600">وصف الصورة<textarea required minLength={4} maxLength={1000} rows={5} value={aiImagePrompt} onChange={(event) => setAiImagePrompt(event.target.value)} placeholder="مثال: تورتة شوكولاتة مزينة بالفراولة على خلفية احتفالية دافئة" disabled={generatingAiImage} className="mt-1 w-full resize-y rounded-xl border border-stone-200 px-3 py-2 text-sm font-normal leading-6" /></label><p className="text-[10px] leading-5 text-stone-400">يتطلب إعداد خدمة توليد الصور في الخادم. قد يستغرق الإنشاء نحو دقيقة.</p><div className="flex justify-end gap-2"><button type="button" disabled={generatingAiImage} onClick={() => setShowAiImageComposer(false)} className="rounded-xl bg-stone-100 px-4 py-2.5 text-xs font-bold text-stone-600 disabled:opacity-40">إلغاء</button><button type="submit" disabled={generatingAiImage || !aiImagePrompt.trim() || !messagingEnabled} className="flex items-center gap-1.5 rounded-xl bg-violet-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"><Sparkles size={14} />{generatingAiImage ? "جارٍ الإنشاء والإرسال..." : "إنشاء وإرسال"}</button></div></form>
      </section></div>}
      {showQuickReplyManager && <AgentQuickRepliesModal onClose={() => setShowQuickReplyManager(false)} onSaved={setAgentQuickReplies} />}
     {showAccount && user && <AccountSettingsModal user={user} onClose={() => setShowAccount(false)} onSaved={setUser} />}
      {showContactCard && <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/40 p-3 backdrop-blur-sm" onClick={() => setShowContactCard(false)}><section role="dialog" aria-modal="true" aria-labelledby="contact-card-title" className="panel flex max-h-[85vh] w-full max-w-lg flex-col p-5" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 id="contact-card-title" className="text-base font-extrabold">إرسال جهة اتصال</h2><p className="mt-1 text-xs text-stone-500">ستُرسل بطاقة الاسم ورقم الهاتف عبر WhatsApp.</p></div><button type="button" onClick={() => setShowContactCard(false)} aria-label="إغلاق جهات الاتصال" className="rounded-lg p-1 text-xl text-stone-400">×</button></div><label className="mb-3 flex h-10 items-center gap-2 rounded-xl bg-stone-50 px-3"><Search size={15} className="text-stone-400" /><input autoFocus value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="ابحث بالاسم أو رقم الهاتف" className="w-full bg-transparent text-xs outline-none" /></label><div className="soft-scroll min-h-32 flex-1 overflow-y-auto">{loadingContacts ? <p className="py-8 text-center text-xs text-stone-400">جارٍ البحث...</p> : contactResults.map((contact) => <button key={contact.id} type="button" disabled={!contact.phone || Boolean(sendingContactId)} onClick={() => void sendContactCard(contact)} className="flex w-full items-center gap-3 border-b border-stone-100 px-2 py-3 text-right hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"><Avatar name={customerDisplayName(contact)} src={contact.avatarUrl} /><span className="min-w-0 flex-1"><b className="block truncate text-xs">{customerDisplayName(contact)}</b><span dir="ltr" className="mt-1 block text-right text-[10px] text-stone-400">{contact.phone || "لا يوجد رقم هاتف"}</span></span><span className="shrink-0 rounded-lg bg-sky-700 px-3 py-2 text-[10px] font-bold text-white">{sendingContactId === contact.id ? "جارٍ الإرسال..." : "إرسال"}</span></button>)}{!loadingContacts && !contactResults.length && <p className="py-8 text-center text-xs text-stone-400">لا توجد جهة اتصال مطابقة.</p>}</div></section></div>}
    </main>;
}

function Avatar({ name, src }: { name: string; src?: string }) { return <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffe3cd] to-[#ffedb4] font-bold text-[#965a36]">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function AvatarLarge({ name, src }: { name: string; src?: string }) { return <span className="mx-auto grid h-16 w-16 place-items-center overflow-hidden rounded-[22px] bg-white text-2xl font-extrabold text-[#b67739] shadow-sm">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : name?.[0] || "ع"}</span>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl bg-stone-50 p-2.5"><p className="text-[9px] text-stone-400">{label}</p><p className="mt-1 truncate text-[10px] font-bold text-stone-700" dir="auto">{value}</p></div>; }
function ChannelIcon({ channel }: { channel: string }) { const config: Record<string, { label: string; className: string }> = { WHATSAPP: { label: "W", className: "bg-emerald-100 text-emerald-700" }, MESSENGER: { label: "M", className: "bg-blue-100 text-blue-700" }, TELEGRAM: { label: "T", className: "bg-sky-100 text-sky-700" } }; const item = config[channel] || config.WHATSAPP; return <span title={channelName(channel)} className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md text-[9px] font-black ${item.className}`}>{item.label}</span>; }
function Message({ message, conversationId, readOnly = false, selectionMode = false, selected = false, onToggleSelection, highlighted = false, highlightQuery = "", onQuote, onEdit, onDelete, deleting = false, onForward, editing = false, editingText = "", onEditingTextChange, onSaveEdit, onCancelEdit, savingEdit = false, onReact, onOpenImage }: { message: AnyRecord; conversationId: string; readOnly?: boolean; selectionMode?: boolean; selected?: boolean; onToggleSelection?: () => void; highlighted?: boolean; highlightQuery?: string; onQuote?: () => void; onEdit?: () => void; onDelete?: () => void; deleting?: boolean; onForward?: () => void; editing?: boolean; editingText?: string; onEditingTextChange?: (value: string) => void; onSaveEdit?: () => void; onCancelEdit?: () => void; savingEdit?: boolean; onReact?: (emoji: string) => void; onOpenImage?: (url: string) => void }) {
  const outgoing = message.direction === "OUTBOUND";
  const hasMedia = ["IMAGE", "AUDIO", "VIDEO", "FILE", "STICKER"].includes(message.kind);
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const contactCard = metadata.contactCard && typeof metadata.contactCard === "object" ? metadata.contactCard : null;
  const deliveryLabel = message.deliveryStatus === "UPLOADING" ? "جارٍ رفع الملف" : message.deliveryStatus === "PENDING" ? "جارٍ الإرسال" : message.deliveryStatus === "QUEUED" ? "في قائمة الإرسال" : message.deliveryStatus === "FAILED" ? "تعذر الإرسال" : message.deliveryStatus === "PLAYED" ? "تم تشغيلها" : message.deliveryStatus === "READ" ? "مقروء" : message.deliveryStatus === "DELIVERED" ? "تم التسليم" : message.author?.name || "تم الإرسال";
        return <div id={`message-${message.id}`} className={`agent-message-row flex items-center gap-2 ${outgoing ? "justify-start" : "justify-end"} ${highlighted ? "search-message-highlight" : ""}`}>{selectionMode && outgoing && <MessageSelectionControl selected={selected} onToggle={onToggleSelection} />}<div className="group relative w-fit max-w-[80%]" style={selectionMode ? { maxWidth: "calc(80% - 2.25rem)" } : undefined}><div className={`agent-message-bubble ${selected ? "ring-2 ring-emerald-500 ring-offset-1" : ""} ${outgoing ? "agent-message-outbound rounded-tr-sm bg-[#d9fdd3]" : "agent-message-inbound rounded-tl-sm bg-white"} max-w-full rounded-2xl px-3 py-2 shadow-sm`}>
    {message.quotedMessage && <div className="mb-2 rounded-lg border-r-2 border-[#d32f2f] bg-stone-50/80 px-2.5 py-1.5 text-[10px] text-stone-500"><b>{message.quotedMessage.author?.name || "رسالة مقتبسة"}</b><p className="mt-0.5 line-clamp-2">{message.quotedMessage.text || (message.quotedMessage.kind === "IMAGE" ? "صورة" : "مرفق")}</p></div>}
    {hasMedia && (message.localPreviewUrl ? ["IMAGE", "STICKER"].includes(message.kind) ? <button type="button" onClick={() => onOpenImage?.(message.localPreviewUrl)} className="mb-2 block"><img src={message.localPreviewUrl} alt={message.kind === "STICKER" ? "ملصق قيد الإرسال" : "صورة قيد الإرسال"} className="max-h-56 rounded-xl object-contain" /></button> : message.kind === "AUDIO" ? <audio controls src={message.localPreviewUrl} className="mb-2 max-w-full" /> : message.kind === "VIDEO" ? <video controls src={message.localPreviewUrl} className="mb-2 max-h-56 max-w-full rounded-xl" /> : <span className="mb-2 block text-xs">ملف مرفق قيد الإرسال</span> : message.mediaAssetId ? <ProtectedMedia conversationId={conversationId} message={message} onOpenImage={onOpenImage} /> : message.kind === "IMAGE" && outgoing && message.mediaUrl ? <button type="button" onClick={() => onOpenImage?.(message.mediaUrl)} className="mb-2 block"><img src={message.mediaUrl} alt="منتج حلواني بندق" className="max-h-56 rounded-xl object-cover" /></button> : <ProtectedMedia conversationId={conversationId} message={message} onOpenImage={onOpenImage} />)}
     {message.kind === "AUDIO" && message.transcription && <p className="mb-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-6 text-stone-700">تفريغ صوتي: {message.transcription}</p>}
     {contactCard && <div className="mb-2 flex min-w-52 items-center gap-3 rounded-xl border border-emerald-100 bg-white p-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-800"><BookUser size={19} /></span><span className="min-w-0"><b className="block truncate text-sm">{contactCard.name || "جهة اتصال"}</b><a href={`tel:+${String(contactCard.phone || "").replace(/[^0-9]/g, "")}`} dir="ltr" className="mt-1 block text-xs text-emerald-800 underline">+{String(contactCard.phone || "").replace(/[^0-9]/g, "")}</a></span></div>}
      {editing ? <div className="my-2 min-w-[230px]"><textarea autoFocus rows={3} maxLength={4000} value={editingText} onChange={(event) => onEditingTextChange?.(event.target.value)} className="w-full resize-y rounded-xl border border-amber-200 bg-white p-2 text-sm leading-6 outline-none focus:border-amber-400" /><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={onCancelEdit} className="rounded-lg bg-stone-100 px-3 py-1.5 text-[10px] font-bold text-stone-600">إلغاء</button><button type="button" disabled={savingEdit || !editingText.trim()} onClick={onSaveEdit} className="rounded-lg bg-[#d32f2f] px-3 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">{savingEdit ? "جارٍ الحفظ..." : "حفظ التعديل"}</button></div></div> : message.kind === "POLL" ? <div className="min-w-[220px] rounded-xl border border-sky-100 bg-sky-50/60 p-3"><div className="mb-1 text-[9px] font-extrabold uppercase tracking-wide text-sky-700">استطلاع</div><p className="whitespace-pre-wrap text-sm font-bold leading-6">{message.text}</p><div className="mt-2 space-y-1.5">{(Array.isArray(metadata.pollOptions) ? metadata.pollOptions : []).map((option: string, index: number) => <div key={`${option}-${index}`} className="rounded-lg border border-sky-100 bg-white px-2.5 py-1.5 text-xs">{option}</div>)}</div><p className="mt-2 text-[9px] text-stone-400">التصويت والنتائج متاحان على المنصة الأصلية.</p></div> : message.kind === "LOCATION" ? <a className="flex items-center gap-2 text-sm text-blue-700 underline" href={`https://maps.google.com/?q=${message.latitude},${message.longitude}`} target="_blank" rel="noopener noreferrer"><MapPin size={16} /> فتح موقع العميل</a> : message.text && <p className="message-body whitespace-pre-wrap text-sm leading-7">{splitMessageTextLinks(message.text).map((part, index) => part.href ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" dir="ltr" className="text-blue-700 underline decoration-blue-300 underline-offset-2">{part.text}</a> : <span key={index}>{part.text}</span>)}</p>}
      <div className="agent-message-time mt-1.5 flex flex-wrap items-center gap-1 text-[9px] text-stone-400">{metadata.forwardedFrom && <span>محوّلة · </span>}{outgoing && `${deliveryLabel} · `}{formatCairoTime(message.createdAt)}{outgoing && message.deliveredAt && <span title="وقت التسليم"> · تسليم {formatCairoTime(message.deliveredAt)}</span>}{outgoing && message.readAt && <span title="وقت القراءة"> · قراءة {formatCairoTime(message.readAt)}</span>}{outgoing && message.playedAt && <span title="وقت التشغيل"> · تشغيل {formatCairoTime(message.playedAt)}</span>}{metadata.editedAt && <span className="text-stone-400"> · معدلة</span>}{outgoing && ["SENT", "DELIVERED", "READ", "PLAYED"].includes(message.deliveryStatus) && (message.deliveryStatus === "SENT" ? <Check size={11} className="text-stone-400" /> : <CheckCheck size={11} className={message.deliveryStatus === "READ" || message.deliveryStatus === "PLAYED" ? "text-sky-600" : "text-stone-400"} />)}</div>
       {!!message.reactions?.length && <div className="mt-2 flex flex-wrap gap-1">{message.reactions.map((reaction: AnyRecord) => readOnly ? <span key={reaction.id} title={reaction.user?.name || "تفاعل"} className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[10px]">{reaction.emoji}</span> : <button key={reaction.id} type="button" title={reaction.user?.name || "تفاعل"} onClick={() => onReact?.(reaction.emoji)} className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[10px]">{reaction.emoji}</button>)}</div>}
        {!selectionMode && <div className="mt-2 flex items-center justify-end gap-1 border-t border-stone-100/70 pt-1.5"><button type="button" onClick={() => message.onToggleStar?.()} title={message.isStarred ? "إزالة من الرسائل المميزة" : "حفظ في الرسائل المميزة"} aria-label={message.isStarred ? "إزالة من الرسائل المميزة" : "حفظ في الرسائل المميزة"} aria-pressed={Boolean(message.isStarred)} className={`grid h-7 w-7 place-items-center rounded-lg hover:bg-amber-50 ${message.isStarred ? "text-amber-500" : "text-stone-400 hover:text-amber-600"}`}><Star size={14} fill={message.isStarred ? "currentColor" : "none"} /></button>{!readOnly && <>{onEdit && <button type="button" onClick={onEdit} title="تعديل الرسالة" aria-label="تعديل الرسالة" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-white hover:text-stone-700"><Pencil size={13} /></button>}{onDelete && <button type="button" disabled={deleting} onClick={onDelete} title="حذف الرسالة" aria-label="حذف الرسالة" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"><Trash2 size={13} /></button>}{onForward && message.kind !== "SYSTEM" && <button type="button" onClick={onForward} title="تحويل الرسالة إلى محادثة أخرى" aria-label="تحويل الرسالة إلى محادثة أخرى" className="grid h-7 w-7 place-items-center rounded-lg text-stone-400 hover:bg-white hover:text-stone-700"><Forward size={13} /></button>}{["👍", "❤️", "😂"].map((emoji) => <button type="button" key={emoji} onClick={() => onReact?.(emoji)} title={`تفاعل ${emoji}`} className="grid h-7 min-w-7 place-items-center rounded-lg text-sm hover:bg-white">{emoji}</button>)}</>}</div>}
    </div>{!readOnly && !selectionMode && onQuote && <button type="button" onClick={onQuote} aria-label="الرد على هذه الرسالة" title="الرد على هذه الرسالة" className={`message-quote-button absolute top-1/2 z-10 flex h-9 -translate-y-1/2 items-center gap-1 rounded-full border border-stone-200 bg-white px-2 text-[10px] font-bold text-stone-600 shadow-lg ${outgoing ? "-left-10" : "-right-10"}`}><ReplyIcon size={14} /><span>رد</span></button>}</div>{selectionMode && !outgoing && <MessageSelectionControl selected={selected} onToggle={onToggleSelection} />}</div>;
}
function MessageSelectionControl({ selected, onToggle }: { selected: boolean; onToggle?: () => void }) {
  return <button type="button" aria-label={selected ? "إلغاء تحديد الرسالة" : "تحديد الرسالة"} aria-pressed={selected} onClick={onToggle} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition ${selected ? "border-emerald-700 bg-emerald-700 text-white" : "border-stone-300 bg-white text-stone-400 hover:border-emerald-500 hover:text-emerald-700"}`}>{selected ? <Check size={15} /> : <Circle size={16} />}</button>;
}
function department(value?: string) { return ({ CAKES: "مبيعات التورتات", DELIVERY: "طلبات التوصيل", CUSTOMER_CARE: "خدمة العملاء", QUALITY: "قسم الجودة", HEADQUARTERS: "المقر الرئيسي · HQ", WORK_FROM_HOME: "العمل من المنزل · WFH", BRANCH: "خدمة العملاء", ADMINISTRATION: "الإدارة" } as Record<string, string>)[value || ""] || "فريق بندق"; }
function channelName(value: string) { return ({ WHATSAPP: "واتساب", MESSENGER: "ماسنجر", TELEGRAM: "تليجرام" } as Record<string, string>)[value] || value; }
function conversationStatusLabel(value: string) { return ({ OPEN: "مفتوحة", PENDING: "بانتظار الرد", QUEUED: "في قائمة الانتظار", RESOLVED: "تم الحل", CLOSED: "مؤرشفة" } as Record<string, string>)[value] || value; }
function HighlightedText({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0 || !query) return <>{text}</>;
  return <>{text.slice(0, index)}<mark className="rounded bg-amber-200 px-0.5 text-stone-900">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
function ago(value?: string) { if (!value) return "الآن"; const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? "الآن" : minutes < 60 ? `منذ ${minutes} د` : `منذ ${Math.floor(minutes / 60)} س`; }
function isWaitingForAgent(conversation: AnyRecord) { return ["OPEN", "PENDING", "QUEUED"].includes(conversation.status) && Boolean(conversation.lastInboundAt && (!conversation.lastAgentResponseAt || Date.parse(conversation.lastInboundAt) > Date.parse(conversation.lastAgentResponseAt))); }
function orderStatus(value: string) { return ({ DRAFT: "مسودة", CONFIRMED: "مؤكد", PREPARING: "قيد التجهيز", OUT_FOR_DELIVERY: "خرج للتوصيل", DELIVERED: "تم التسليم", CANCELLED: "ملغي", COMPLETED: "مكتمل" } as Record<string, string>)[value] || value; }
function categoryLabel(value: string) { return productCategoryLabel[value] || value; }
function formatCountdown(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`; }
function callStatusLabel(value: string) { return ({ INITIATING: "جارٍ الاتصال", RINGING: "يرن", CONNECTED: "تم الاتصال", TERMINATED: "انتهت", REJECTED: "مرفوضة", FAILED: "فشلت" } as Record<string, string>)[value] || value; }

function SecretNoteComposer({ text, onTextChange, recipients, recipientId, onRecipientChange, sending, onSubmit }: { text: string; onTextChange: (value: string) => void; recipients: AnyRecord[]; recipientId: string; onRecipientChange: (value: string) => void; sending: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const hasRecipient = recipients.some((recipient) => recipient.id === recipientId);
  const presenceLabels: Record<string, string> = { ONLINE: "متصل", BUSY: "مشغول", BREAK: "استراحة", OFFLINE: "غير متصل" };
  return <details className="mb-3 rounded-xl border border-violet-200 bg-violet-50/60 p-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-extrabold text-violet-900"><LockKeyhole size={14} /> رسالة سرية لزميل <span className="mr-auto text-[9px] font-normal text-violet-600">المسند يُختار تلقائيًا · للمصرّح لهم فقط</span></summary>
    <form onSubmit={onSubmit} className="mt-2 flex flex-col gap-2">
      <label className="flex min-h-10 items-center gap-2 rounded-lg border border-violet-200 bg-white px-3 text-xs"><UserRound size={15} className="shrink-0 text-violet-600" /><select aria-label="الزميل المستلم" value={recipientId} onChange={(event) => onRecipientChange(event.target.value)} disabled={!recipients.length || sending} className="min-w-0 flex-1 bg-transparent py-2 outline-none disabled:text-stone-400"><option value="">{recipients.length ? "اختر الزميل" : "لا يوجد زملاء ضمن صلاحية هذه المحادثة"}</option>{recipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name}{presenceLabels[recipient.presence] ? ` · ${presenceLabels[recipient.presence]}` : ""}</option>)}</select></label>
      <textarea aria-label="نص الرسالة السرية" value={text} onChange={(event) => onTextChange(event.target.value)} maxLength={4000} rows={2} placeholder="اكتب رسالة لا يراها العميل أو بقية الفريق..." disabled={sending} className="min-h-10 min-w-0 flex-1 resize-y rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs leading-5 outline-none placeholder:text-stone-400 focus:border-violet-400 disabled:bg-stone-100" />
      <button type="submit" disabled={sending || !hasRecipient || !text.trim()} className="flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-violet-700 px-4 text-[10px] font-bold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"><Send size={13} />{sending ? "جارٍ الإرسال..." : "إرسال سري"}</button>
    </form>
    {!recipients.length && <p className="mt-2 text-[10px] text-violet-700">لا يوجد زملاء مؤهّلون لهذه المحادثة حاليًا. يمكنك كتابة الرسالة هنا وإرسالها بعد اختيار زميل.</p>}
    {recipients.some((recipient) => recipient.presence !== "ONLINE") && <p className="mt-2 text-[10px] text-violet-700">يمكن إرسال الرسالة للزميل غير المتصل؛ ستظهر له عند عودته.</p>}
  </details>;
}
