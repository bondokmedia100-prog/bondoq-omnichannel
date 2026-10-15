type Message = { id?: string; createdAt?: string; [key: string]: any };

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

export function messageNotificationPreview(message?: { text?: string | null; kind?: string } | null) {
  const text = message?.text?.trim();
  if (text) return text;
  return ({ IMAGE: "صورة جديدة", STICKER: "ملصق جديد", AUDIO: "رسالة صوتية جديدة", FILE: "ملف مرفق جديد", LOCATION: "موقع جديد" } as Record<string, string>)[message?.kind || ""] || "رسالة جديدة";
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
