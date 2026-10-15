import { config } from "./config";
import { prisma } from "./prisma";
import { io } from "./realtime";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function audioFileName(contentType: string) {
  const extension = contentType === "audio/mp4" ? "m4a"
    : contentType === "audio/ogg" ? "ogg"
      : contentType === "audio/mpeg" ? "mp3" : "webm";
  return `call-recording.${extension}`;
}

async function transcribeAudio(data: Uint8Array, contentType: string) {
  if (data.byteLength > MAX_AUDIO_BYTES) throw new Error("LIMIT");
  const audio = new ArrayBuffer(data.byteLength);
  new Uint8Array(audio).set(data);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), audioFileName(contentType));
  form.append("model", config.openaiTranscriptionModel);
  form.append("response_format", "json");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${config.openaiApiKey}` }, body: form, signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`OPENAI_${response.status}`);
  const result = await response.json() as { text?: string };
  const transcript = result.text?.trim();
  if (!transcript) throw new Error("EMPTY_TRANSCRIPT");
  return transcript.slice(0, 30_000);
}

async function summarizeTranscript(transcript: string) {
  const settings = await prisma.callRecordingSettings.findUnique({ where: { id: "default" } });
  if (!settings?.enabled || !settings.aiProcessingEnabled) throw new Error("AI_DISABLED");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.openaiSummaryModel,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: "لخّص مكالمة خدمة عملاء بالعربية في نقاط قصيرة: سبب الاتصال، احتياج العميل، ما تم الاتفاق عليه، والإجراء أو المتابعة المطلوبة. لا تخترع معلومات؛ اكتب (غير مذكور) عند غيابها. أخرج الملخص فقط." },
        { role: "user", content: transcript }
      ]
    }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`OPENAI_${response.status}`);
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const summary = result.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error("EMPTY_SUMMARY");
  return summary.slice(0, 5_000);
}

function safeFailureMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "LIMIT") return "تجاوز التسجيل حد OpenAI المسموح للتفريغ الصوتي.";
  if (code === "EMPTY_TRANSCRIPT") return "لم ينتج التفريغ نصًا واضحًا.";
  if (code === "EMPTY_SUMMARY") return "تعذر إنشاء ملخص للمكالمة.";
  if (code === "AI_DISABLED") return "أوقف المشرف المعالجة الآلية أثناء التنفيذ.";
  const status = code.match(/^OPENAI_(\d{3})$/)?.[1];
  return status ? `تعذرت المعالجة عبر OpenAI (HTTP ${status}).` : "تعذر الاتصال بخدمة المعالجة الآلية.";
}

async function emitRecordingUpdate(recordingId: string, conversationId: string) {
  const recording = await prisma.callRecording.findUnique({
    where: { id: recordingId },
    select: { id: true, transcript: true, summary: true, aiProcessingStatus: true, aiProcessingError: true, aiProcessedAt: true }
  });
  if (recording) io.to("admins").emit("call-recording:updated", { conversationId, recording });
}

export async function processCallRecordingAi(recordingId: string) {
  const staleBefore = new Date(Date.now() - 30_000);
  const recording = await prisma.callRecording.findUnique({
    where: { id: recordingId },
    include: { mediaAsset: { select: { data: true, contentType: true } }, session: { select: { conversationId: true, recordingConsentAt: true, aiProcessingConsentAt: true } } }
  });
  if (!recording || recording.reviewedAt || !["PENDING", "FAILED"].includes(recording.aiProcessingStatus) && !(recording.aiProcessingStatus === "PROCESSING" && recording.updatedAt < staleBefore)) return;
  const claimable = { OR: [
    { aiProcessingStatus: { in: ["PENDING", "FAILED"] } },
    { aiProcessingStatus: "PROCESSING", updatedAt: { lt: staleBefore } }
  ] };
  const settings = await prisma.callRecordingSettings.findUnique({ where: { id: "default" } });
  const authorized = Boolean(config.openaiApiKey && settings?.enabled && settings.aiProcessingEnabled && recording.session.recordingConsentAt && recording.session.aiProcessingConsentAt);
  if (!authorized) {
    await prisma.callRecording.updateMany({ where: { id: recording.id, ...claimable }, data: { aiProcessingStatus: "NOT_REQUESTED" } });
    await emitRecordingUpdate(recording.id, recording.session.conversationId);
    return;
  }
  const claimed = await prisma.callRecording.updateMany({
    where: { id: recording.id, ...claimable },
    data: { aiProcessingStatus: "PROCESSING", aiProcessingError: null }
  });
  if (!claimed.count) return;

  try {
    if (!config.openaiApiKey) throw new Error("NO_API_KEY");
    const contentType = recording.mediaAsset.contentType.split(";")[0].toLowerCase();
    const transcript = recording.transcript || await transcribeAudio(new Uint8Array(recording.mediaAsset.data), contentType);
    await prisma.callRecording.updateMany({ where: { id: recording.id, aiProcessingStatus: "PROCESSING", reviewedAt: null }, data: { transcript } });
    const summary = await summarizeTranscript(transcript);
    const saved = await prisma.callRecording.updateMany({ where: { id: recording.id, aiProcessingStatus: "PROCESSING", reviewedAt: null }, data: { transcript, summary, aiProcessingStatus: "COMPLETE", aiProcessingError: null, aiProcessedAt: new Date() } });
    if (!saved.count) await prisma.callRecording.updateMany({ where: { id: recording.id, aiProcessingStatus: "PROCESSING" }, data: { aiProcessingStatus: "COMPLETE", aiProcessingError: null, aiProcessedAt: new Date() } });
  } catch (error) {
    await prisma.callRecording.update({ where: { id: recording.id }, data: { aiProcessingStatus: "FAILED", aiProcessingError: error instanceof Error && error.message === "NO_API_KEY" ? "خدمة OpenAI غير مهيأة على الخادم." : safeFailureMessage(error) } });
    await emitRecordingUpdate(recording.id, recording.session.conversationId);
    throw error;
  }
  await emitRecordingUpdate(recording.id, recording.session.conversationId);
}
