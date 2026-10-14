import { MessageKind } from "@prisma/client";
import { config } from "./config";
import { fetchInboundMedia } from "./providers";
import { prisma } from "./prisma";
import { io } from "./realtime";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function transcribeAudioMessage(messageId: string) {
  if (!config.openaiApiKey) return;
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { conversation: true, mediaAsset: true } });
  if (!message || message.kind !== MessageKind.AUDIO || message.transcription) return;
  const media = message.mediaAsset
    ? { body: Buffer.from(message.mediaAsset.data), contentType: message.mediaAsset.contentType }
    : await fetchInboundMedia(message.conversation.channel, (message.metadata || {}) as unknown as Record<string, unknown>, message.mediaUrl || undefined);
  if (media.body.length > MAX_AUDIO_BYTES) throw new Error("Voice note exceeds the 25 MB transcription limit");

  const bytes = new ArrayBuffer(media.body.length);
  new Uint8Array(bytes).set(media.body);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: media.contentType }), "voice-note.ogg");
  form.append("model", config.openaiTranscriptionModel);
  form.append("response_format", "json");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${config.openaiApiKey}` }, body: form
  });
  if (!response.ok) throw new Error(`Audio transcription failed (${response.status}): ${await response.text()}`);
  const result = await response.json() as { text?: string };
  const transcript = result.text?.trim();
  if (!transcript) return;
  const updated = await prisma.message.update({ where: { id: message.id }, data: { transcription: transcript } });
  io.to(`conversation:${message.conversationId}`).to("admins").emit("message:transcribed", { conversationId: message.conversationId, message: updated });
  if (message.conversation.assignedAgentId) io.to(`agent:${message.conversation.assignedAgentId}`).emit("message:transcribed", { conversationId: message.conversationId, message: updated });
}
