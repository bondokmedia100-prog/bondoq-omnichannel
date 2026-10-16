export type BaileysMessageKey = {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  [key: string]: unknown;
};

export function serializeBaileysMessageKey(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const key = value as Record<string, unknown>;
  if (typeof key.remoteJid !== "string" || !key.remoteJid || typeof key.id !== "string" || !key.id || key.fromMe !== true) return undefined;
  return `baileys-key:${Buffer.from(JSON.stringify(key)).toString("base64url")}`;
}

export function parseStoredBaileysMessageKey(externalId: string, direction: "INBOUND" | "OUTBOUND"): BaileysMessageKey | null {
  const raw = externalId.replace(/^WHATSAPP:/, "");
  if (raw.startsWith("baileys-key:")) {
    try {
      const value = JSON.parse(Buffer.from(raw.slice("baileys-key:".length), "base64url").toString("utf8"));
      if (value && typeof value.remoteJid === "string" && value.remoteJid && typeof value.id === "string" && value.id && value.fromMe === (direction === "OUTBOUND")) return value;
    } catch {}
    return null;
  }
  if (raw.startsWith("baileys:")) {
    const value = raw.slice("baileys:".length);
    const split = value.lastIndexOf(":");
    if (split > 0 && split < value.length - 1) return { remoteJid: value.slice(0, split), id: value.slice(split + 1), fromMe: direction === "OUTBOUND" };
  }
  return null;
}
