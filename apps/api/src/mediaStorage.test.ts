import assert from "node:assert/strict";
import test from "node:test";
import { allowedMediaTypes, publicMediaUrl, safeFileName, verifyPublicMediaUrl } from "./mediaStorage";

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
