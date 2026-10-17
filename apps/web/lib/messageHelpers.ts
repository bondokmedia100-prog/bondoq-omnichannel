type Message = { id?: string; createdAt?: string; [key: string]: any };
export type MessageTextPart = { text: string; href?: string };

export function mergeMessages(messages: Message[] = [], incoming: Message[] | Message) {
  const merged = new Map<string, Message>();
  for (const message of [...messages, ...(Array.isArray(incoming) ? incoming : [incoming])]) {
    if (message?.id) merged.set(message.id, { ...merged.get(message.id), ...message });
  }
  return [...merged.values()].sort((left, right) => {
    const timeOrder = Date.parse(left.createdAt || "") - Date.parse(right.createdAt || "");
    return (Number.isNaN(timeOrder) ? 0 : timeOrder) || String(left.id).localeCompare(String(right.id));
  });
}

export function mergePendingMessage(messages: Message[] = [], incoming: Message, clientMessageId?: string) {
  const pending = clientMessageId ? messages.find((message) => message.id === clientMessageId) : undefined;
  const resolved = pending?.localPreviewUrl ? { ...incoming, localPreviewUrl: pending.localPreviewUrl } : incoming;
  return mergeMessages(clientMessageId ? messages.filter((message) => message.id !== clientMessageId) : messages, resolved);
}

export function latestOutgoingTextMessage(messages: Message[] = [], authorId?: string) {
  if (!authorId) return undefined;
  return [...messages].reverse().find((message) =>
    message.direction === "OUTBOUND" && message.authorId === authorId && message.kind === "TEXT" &&
    ["SENT", "DELIVERED", "READ"].includes(message.deliveryStatus) && typeof message.text === "string" && Boolean(message.text.trim())
  );
}

export function messageNotificationPreview(message?: { text?: string | null; kind?: string } | null) {
  const text = message?.text?.trim();
  if (text) return text;
  return ({ IMAGE: "صورة جديدة", STICKER: "ملصق جديد", AUDIO: "رسالة صوتية جديدة", FILE: "ملف مرفق جديد", LOCATION: "موقع جديد" } as Record<string, string>)[message?.kind || ""] || "رسالة جديدة";
}

export function splitMessageTextLinks(text: string): MessageTextPart[] {
  const parts: MessageTextPart[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const trailingPunctuation = /[.,!?;:،؛؟。»]+$/u;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const candidate = match[0].replace(trailingPunctuation, "");
    if (!candidate) continue;
    const href = candidate.startsWith("www.") ? `https://${candidate}` : candidate;
    try {
      const parsed = new URL(href);
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) continue;
      if (start > cursor) parts.push({ text: text.slice(cursor, start) });
      parts.push({ text: candidate, href: parsed.href });
      cursor = start + candidate.length;
    } catch {
      continue;
    }
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length ? parts : [{ text }];
}

export function hasMessageTextLinks(text?: string | null) {
  return Boolean(text && splitMessageTextLinks(text).some((part) => Boolean(part.href)));
}

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext ||= new AudioContextConstructor();
  return audioContext;
}

export function setNotificationSoundEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("bondoq-notification-sound", enabled ? "on" : "off");
  if (enabled) void getAudioContext()?.resume();
}

export function isNotificationSoundEnabled() {
  return typeof window === "undefined" || window.localStorage.getItem("bondoq-notification-sound") !== "off";
}

export function playIncomingMessageTone() {
  if (!isNotificationSoundEnabled()) return;
  const context = getAudioContext();
  if (!context) return;
  void context.resume().then(() => {
    const start = context.currentTime;
    for (const [index, frequency] of [880, 1174].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, start + index * 0.12 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + index * 0.12);
      oscillator.stop(start + index * 0.12 + 0.17);
    }
  }).catch(() => {});
}
