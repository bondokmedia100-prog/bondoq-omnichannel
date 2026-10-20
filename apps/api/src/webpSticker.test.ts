import assert from "node:assert/strict";
import test from "node:test";
import { isAnimatedWebp, isWebmContainer } from "./webpSticker";

function webp(...chunks: string[]) {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks.map((kind) => {
    const chunk = Buffer.alloc(8);
    chunk.write(kind, 0, "ascii");
    return chunk;
  })]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("distinguishes static and animated WebP chunks", () => {
  assert.equal(isAnimatedWebp(webp("VP8 ")), false);
  assert.equal(isAnimatedWebp(webp("ANIM")), true);
  assert.equal(isAnimatedWebp(webp("ANMF")), true);
});

test("recognizes a WebM container signature", () => {
  assert.equal(isWebmContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), true);
  assert.equal(isWebmContainer(Buffer.from("RIFF")), false);
});
