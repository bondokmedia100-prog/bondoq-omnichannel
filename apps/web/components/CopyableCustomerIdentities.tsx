"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { displayPhoneNumber } from "@/lib/egyptianPhoneFormatter";

type Identity = { label: string; value: string };

export function customerIdentityPreview(customer: Record<string, any> | null | undefined, channel: string, externalCustomerId?: string) {
  const username = typeof customer?.channelIdentifiers?.telegramUsername === "string" ? customer.channelIdentifiers.telegramUsername.replace(/^@/, "") : "";
  if (channel === "TELEGRAM" && username) return `@${username}`;
  if (customer?.phone) return displayPhoneNumber(customer.phone);
  if (username) return `@${username}`;
  return externalCustomerId || "";
}

export default function CopyableCustomerIdentities({ customer, channel, externalCustomerId, compact = false }: { customer?: Record<string, any> | null; channel: string; externalCustomerId?: string; compact?: boolean }) {
  const identifiers = customer?.channelIdentifiers || {};
  const customerName = [customer?.displayName, customer?.name].find((value) => typeof value === "string" && value.trim())?.trim() || "";
  const username = typeof identifiers.telegramUsername === "string" ? identifiers.telegramUsername.replace(/^@/, "") : "";
  const identities: Identity[] = [
    customerName ? { label: "الاسم", value: customerName } : null,
    customer?.phone ? { label: "الهاتف", value: displayPhoneNumber(customer.phone) } : null,
    username ? { label: "Telegram", value: `@${username}` } : null,
    externalCustomerId && (channel !== "WHATSAPP" || !customer?.phone)
      ? { label: `معرّف ${channel === "TELEGRAM" ? "Telegram" : channel === "MESSENGER" ? "Messenger" : "WhatsApp"}`, value: externalCustomerId }
      : null
  ].filter((identity): identity is Identity => Boolean(identity));
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState(false);

  async function copyIdentity(identity: Identity) {
    try {
      await navigator.clipboard.writeText(identity.value);
      setCopied(identity.label);
      setCopyError(false);
      window.setTimeout(() => setCopied((current) => current === identity.label ? "" : current), 1600);
    } catch {
      setCopied("");
      setCopyError(true);
    }
  }

  if (!identities.length) return null;
  if (compact) {
    const compactIdentities = identities.filter((identity) => identity.label === "الهاتف" || identity.label === "Telegram" || identity.label.startsWith("معرّف") && channel !== "WHATSAPP").slice(0, 2);
    if (!compactIdentities.length) return null;
    return <div className="flex min-w-0 max-w-[min(42vw,250px)] items-center gap-1 overflow-hidden" aria-label="نسخ هوية العميل">
      {compactIdentities.map((identity) => <button key={identity.label} type="button" onClick={() => void copyIdentity(identity)} title={`نسخ ${identity.label}`} aria-label={`نسخ ${identity.label}`} className="flex min-w-0 max-w-[48%] items-center gap-1 rounded-md bg-stone-50 px-1.5 py-1 text-[9px] font-semibold text-stone-600 hover:bg-amber-50 hover:text-amber-800">
        <span className="shrink-0 text-stone-400">{identity.label === "الهاتف" ? "هاتف" : identity.label}</span>
        <span dir="ltr" className="truncate">{identity.value}</span>
        {copied === identity.label ? <Check size={11} className="shrink-0" /> : <Copy size={11} className="shrink-0" />}
      </button>)}
      <span className="sr-only" aria-live="polite">{copyError ? "تعذر النسخ" : copied ? `تم نسخ ${copied}` : ""}</span>
    </div>;
  }
  return <div className="space-y-1.5" aria-label="هويات العميل">
    {identities.map((identity) => <div key={identity.label} className="flex min-w-0 items-center gap-2 rounded-lg bg-white px-2.5 py-2">
      <span className="w-20 shrink-0 text-[9px] text-stone-400">{identity.label}</span>
      <span dir="ltr" className="min-w-0 flex-1 break-all text-left text-[10px] font-semibold text-stone-700">{identity.value}</span>
      <button type="button" onClick={() => void copyIdentity(identity)} aria-label={`نسخ ${identity.label}`} title={copied === identity.label ? "تم النسخ" : `نسخ ${identity.label}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-stone-400 hover:bg-amber-50 hover:text-amber-800">
        {copied === identity.label ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>)}
    <span className="sr-only" aria-live="polite">{copyError ? "تعذر النسخ" : copied ? `تم نسخ ${copied}` : ""}</span>
  </div>;
}
