import { config } from "./config";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { prisma } from "./prisma";

type CloudAction = { action_name?: string; name?: string; can_perform_action?: boolean; canPerformAction?: boolean };

export class WhatsAppCloudApiError extends Error {
  readonly code?: number;
  readonly status?: number;

  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.name = "WhatsAppCloudApiError";
    this.code = code;
    this.status = status;
  }
}

let cachedIrishNumber: { value: string; checkedAt: number } | null = null;

function graphUrl(path: string) {
  if (!/^v\d+\.0$/.test(config.whatsappCloudApiVersion)) throw new Error("WHATSAPP_CLOUD_API_VERSION must look like v23.0");
  return `https://graph.facebook.com/${config.whatsappCloudApiVersion}${path}`;
}

async function graphRequest(path: string, method: "GET" | "POST", payload?: unknown) {
  if (!config.whatsappCloudPhoneNumberId || !config.whatsappCloudAccessToken) {
    throw new Error("أكمل رقم الهاتف ومعرّف Phone Number ID ورمز WhatsApp Cloud API على الخادم أولًا.");
  }
  const response = await fetch(graphUrl(path), {
    method,
    headers: { Authorization: `Bearer ${config.whatsappCloudAccessToken}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(20_000)
  });
  const raw = await response.text();
  let result: any;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw }; }
  if (!response.ok || result?.error) {
    const error = result?.error || {};
    throw new WhatsAppCloudApiError(String(error.message || `Meta Cloud API rejected the request (${response.status})`).slice(0, 500), Number(error.code) || undefined, response.status);
  }
  return result;
}

async function assertIrishCloudLine() {
  if (cachedIrishNumber && Date.now() - cachedIrishNumber.checkedAt < 5 * 60_000) return cachedIrishNumber.value;
  const result = await graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}?fields=display_phone_number`, "GET");
  const displayPhoneNumber = String(result?.display_phone_number || "");
  if (!isIrishCloudPhoneNumber(displayPhoneNumber)) {
    throw new Error("يجب أن يكون رقم WhatsApp Cloud API المستخدم للمكالمات هو الرقم الإيرلندي الذي يبدأ بـ +353؛ المكالمات الصادرة غير مفعلة للأرقام المصرية.");
  }
  cachedIrishNumber = { value: displayPhoneNumber, checkedAt: Date.now() };
  return displayPhoneNumber;
}

export function isIrishCloudPhoneNumber(phone: string) {
  return phone.replace(/\D/g, "").startsWith("353");
}

export function parseCloudCallPermission(result: any) {
  const record = Array.isArray(result?.data) ? result.data[0] : result?.data || result;
  const permission = record?.permission || {};
  const actions: CloudAction[] = Array.isArray(record?.actions) ? record.actions : [];
  const allowed = (name: string) => actions.some((action) => (action.action_name || action.name) === name && (action.can_perform_action ?? action.canPerformAction) === true);
  return {
    status: String(permission.status || "unknown"),
    expiration: Number(permission.expiration || permission.expiration_time || permission.expiration_timestamp || 0) || null,
    canStartCall: allowed("start_call"),
    canRequestPermission: allowed("send_call_permission_request")
  };
}

export function normalizeCloudCallTarget(phone: string) {
  return normalizePhoneNumber(phone);
}

export async function getCloudCallPermission(phone: string) {
  await assertIrishCloudLine();
  const recipient = normalizeCloudCallTarget(phone);
  const result = await graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}/call_permissions?user_wa_id=${encodeURIComponent(recipient)}`, "GET");
  return { phoneNumber: cachedIrishNumber!.value, ...parseCloudCallPermission(result) };
}

export async function requestCloudCallPermission(phone: string) {
  const permission = await getCloudCallPermission(phone);
  if (!permission.canRequestPermission) throw new WhatsAppCloudApiError("لا يسمح WhatsApp بطلب إذن اتصال جديد لهذا العميل الآن. تحقق من وجود طلب سابق أو من حدود الطلبات.", 138006, 409);
  const recipient = normalizeCloudCallTarget(phone);
  const payload = config.whatsappCloudCallPermissionTemplate
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: { name: config.whatsappCloudCallPermissionTemplate, language: { code: config.whatsappCloudCallPermissionLanguage } }
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "interactive",
        interactive: {
          type: "call_permission_request",
          action: { name: "call_permission_request" },
          body: { text: "نرغب في الاتصال بك صوتيًا عبر واتساب لمساعدتك. هل تسمح لنا بذلك؟" }
        }
      };
  return graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}/messages`, "POST", payload);
}

export async function startCloudCall(input: { phone: string; offerSdp: string; callbackData: string }) {
  await assertIrishCloudLine();
  const permission = parseCloudCallPermission(await graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}/call_permissions?user_wa_id=${encodeURIComponent(normalizeCloudCallTarget(input.phone))}`, "GET"));
  if (!permission.canStartCall) throw new WhatsAppCloudApiError("لم يمنح العميل إذنًا ساريًا للاتصال عبر WhatsApp. أرسل طلب الإذن وانتظر موافقته أولًا.", 138006, 409);
  const result = await graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}/calls`, "POST", {
    messaging_product: "whatsapp",
    to: normalizeCloudCallTarget(input.phone),
    action: "connect",
    session: { sdp_type: "offer", sdp: input.offerSdp },
    biz_opaque_callback_data: input.callbackData
  });
  const callId = String(result?.calls?.[0]?.id || "");
  if (!callId) throw new Error("قبل Meta طلب الاتصال دون إرجاع معرّف للمكالمة.");
  return callId;
}

export async function terminateCloudCall(callId: string) {
  await assertIrishCloudLine();
  return graphRequest(`/${encodeURIComponent(config.whatsappCloudPhoneNumberId)}/calls`, "POST", {
    messaging_product: "whatsapp", call_id: callId, action: "terminate"
  });
}

export async function processCloudCallWebhooks(body: any) {
  const changed: Array<{ agentId: string; sessionId: string; status: string }> = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "calls") continue;
      const value = change.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || "");
      if (phoneNumberId && phoneNumberId !== config.whatsappCloudPhoneNumberId) continue;
      for (const call of Array.isArray(value.calls) ? value.calls : []) {
        const sessionId = typeof call.biz_opaque_callback_data === "string" ? call.biz_opaque_callback_data : "";
        const providerCallId = typeof call.id === "string" ? call.id : "";
        if (!sessionId && !providerCallId) continue;
        const current = sessionId
          ? await prisma.whatsAppCallSession.findUnique({ where: { id: sessionId } })
          : await prisma.whatsAppCallSession.findUnique({ where: { providerCallId } });
        if (!current || current.status === "TERMINATED" || current.status === "REJECTED" || current.status === "FAILED") continue;
        const event = String(call.event || "").toLowerCase();
        if (event === "connect") {
          const sdpAnswer = String(call.session?.sdp || call.connection?.webrtc?.sdp || "");
          if (!sdpAnswer) continue;
          const updated = await prisma.whatsAppCallSession.update({ where: { id: current.id }, data: {
            ...(providerCallId ? { providerCallId } : {}), status: current.status === "CONNECTED" ? "CONNECTED" : "RINGING", sdpAnswer, lastError: null
          } });
          changed.push({ agentId: updated.agentId, sessionId: updated.id, status: updated.status });
        } else if (event === "terminate") {
          const callStatuses = (Array.isArray(call.status) ? call.status : call.status ? [call.status] : []).map((status: unknown) => String(status).toLowerCase());
          const failed = callStatuses.includes("failed");
          const updated = await prisma.whatsAppCallSession.update({ where: { id: current.id }, data: {
            ...(providerCallId ? { providerCallId } : {}), status: failed ? "FAILED" : "TERMINATED", sdpAnswer: null, endedAt: new Date(),
            ...(failed ? { lastError: "أنهى WhatsApp المكالمة قبل اكتمال الاتصال." } : {})
          } });
          changed.push({ agentId: updated.agentId, sessionId: updated.id, status: updated.status });
        }
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        const providerCallId = typeof status.id === "string" ? status.id : "";
        if (!providerCallId) continue;
        const current = await prisma.whatsAppCallSession.findUnique({ where: { providerCallId } });
        if (!current || current.status === "TERMINATED" || current.status === "REJECTED" || current.status === "FAILED") continue;
        const nextStatus = String(status.status || "").toUpperCase();
        const mapped = nextStatus === "ACCEPTED" ? "CONNECTED" : nextStatus === "REJECTED" ? "REJECTED" : nextStatus === "RINGING" ? "RINGING" : "";
        if (!mapped) continue;
        const safeStatus = current.status === "CONNECTED" && mapped === "RINGING" ? current.status : mapped;
        const updated = await prisma.whatsAppCallSession.update({ where: { id: current.id }, data: {
          status: safeStatus,
          ...(safeStatus === "REJECTED" ? { endedAt: new Date(), lastError: "رفض العميل المكالمة." } : {})
        } });
        changed.push({ agentId: updated.agentId, sessionId: updated.id, status: updated.status });
      }
    }
  }
  return changed;
}

export function cloudCallWebhookSecret() {
  return config.whatsappCloudAppSecret || config.metaAppSecret;
}

export function cloudCallWebhookVerifyToken() {
  return config.whatsappCloudVerifyToken || config.metaVerifyToken;
}
