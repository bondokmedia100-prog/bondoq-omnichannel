import { z } from "zod";
import { detectImageContentType, uploadLimitBytes } from "./mediaStorage";

export const aiImagePromptSchema = z.object({ prompt: z.string().trim().min(4).max(1000) }).strict();

const PROVIDER_TIMEOUT_MS = 90_000;
const MAX_PROVIDER_RESPONSE_BYTES = 17 * 1024 * 1024;
const MAX_BASE64_IMAGE_LENGTH = 4 * Math.ceil(uploadLimitBytes / 3);

export class AiImageGenerationError extends Error {
  constructor(readonly code: "timeout" | "provider" | "invalid_response" | "too_large") {
    super(code);
  }
}

async function readBoundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AiImageGenerationError("invalid_response");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AiImageGenerationError("too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AiImageGenerationError) throw error;
    throw new AiImageGenerationError("invalid_response");
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as { data?: Array<{ b64_json?: unknown }> };
  } catch {
    throw new AiImageGenerationError("invalid_response");
  }
}

export async function generateAiImage(prompt: string, apiKey: string, fetcher: typeof fetch = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1-mini", prompt, size: "1024x1024", quality: "low", output_format: "jpeg" }),
        signal: controller.signal
      });
    } catch {
      throw new AiImageGenerationError(controller.signal.aborted ? "timeout" : "provider");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AiImageGenerationError("provider");
    }

    const result = await readBoundedJson(response);
    const base64 = result.data?.[0]?.b64_json;
    if (typeof base64 !== "string" || !base64.length) throw new AiImageGenerationError("invalid_response");
    if (base64.length > MAX_BASE64_IMAGE_LENGTH) throw new AiImageGenerationError("too_large");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new AiImageGenerationError("invalid_response");

    const data = Buffer.from(base64, "base64");
    if (data.length > uploadLimitBytes) throw new AiImageGenerationError("too_large");
    if (!data.length || data.toString("base64") !== base64) throw new AiImageGenerationError("invalid_response");
    const contentType = detectImageContentType(data);
    if (contentType !== "image/jpeg" && contentType !== "image/png") throw new AiImageGenerationError("invalid_response");
    return { data, contentType };
  } catch (error) {
    if (controller.signal.aborted) throw new AiImageGenerationError("timeout");
    if (error instanceof AiImageGenerationError) throw error;
    throw new AiImageGenerationError("provider");
  } finally {
    clearTimeout(timeout);
  }
}
