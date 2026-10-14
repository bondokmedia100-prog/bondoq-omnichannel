import assert from "node:assert/strict";
import test from "node:test";
import { allowedMediaTypes, imageSignatureMatches, publicMediaUrl, safeFileName, verifyPublicMediaUrl } from "./mediaStorage";

test("signed media links validate and reject tampering", () => {
  const url = new URL(publicMediaUrl("asset-test", 600));
  assert.equal(verifyPublicMediaUrl("asset-test", url.searchParams.get("expires"), url.searchParams.get("signature")), true);
  assert.equal(verifyPublicMediaUrl("other-asset", url.searchParams.get("expires"), url.searchParams.get("signature")), false);
  assert.equal(verifyPublicMediaUrl("asset-test", url.searchParams.get("expires"), "bad-signature"), false);
});

test("upload allowlist and filenames exclude executable media and path components", () => {
  assert.equal(allowedMediaTypes.has("image/png"), true);
  assert.equal(allowedMediaTypes.has("image/svg+xml"), false);
  assert.equal(safeFileName("../invoice.pdf"), ".._invoice.pdf");
  assert.equal(safeFileName(""), "attachment");
});

test("uploaded images must match their declared file type", () => {
  assert.equal(imageSignatureMatches("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(imageSignatureMatches("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])), true);
  assert.equal(imageSignatureMatches("image/webp", Buffer.from("RIFFxxxxWEBP")), true);
  assert.equal(imageSignatureMatches("image/png", Buffer.from("not an image")), false);
  assert.equal(imageSignatureMatches("application/pdf", Buffer.from("%PDF-")), true);
});
