import assert from "node:assert/strict";
import test from "node:test";
import { AiImageGenerationError, aiImagePromptSchema, generateAiImage } from "./aiImage";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test("AI image prompt is trimmed and limited to 4-1000 characters", () => {
  assert.equal(aiImagePromptSchema.parse({ prompt: "   blue cake   " }).prompt, "blue cake");
  assert.equal(aiImagePromptSchema.safeParse({ prompt: " abc " }).success, false);
  assert.equal(aiImagePromptSchema.safeParse({ prompt: "x".repeat(1001) }).success, false);
  assert.equal(aiImagePromptSchema.safeParse({ prompt: "valid prompt", extra: true }).success, false);
});

test("AI image generation uses the low-cost model and returns verified JPEG bytes", async () => {
  let requestBody: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  const image = await generateAiImage("A blue cake", "test-secret", async (input, init) => {
    assert.equal(input, "https://api.openai.com/v1/images/generations");
    authorization = new Headers(init?.headers).get("Authorization");
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64") }] }), { status: 200 });
  });

  assert.equal(authorization, "Bearer test-secret");
  assert.deepEqual(requestBody, {
    model: "gpt-image-1-mini", prompt: "A blue cake", size: "1024x1024", quality: "low", output_format: "jpeg"
  });
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual(image.data, jpeg);
});

test("AI image provider failures do not expose provider response details", async () => {
  await assert.rejects(
    generateAiImage("A blue cake", "test-secret", async () => new Response("private provider details", { status: 401 })),
    (error: unknown) => error instanceof AiImageGenerationError && error.code === "provider" && !error.message.includes("private")
  );
});
