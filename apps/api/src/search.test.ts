import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchDigits } from "./search";

test("normalizes Arabic and Persian phone digits for search", () => {
  assert.equal(normalizeSearchDigits("+٢٠ (١٠) ١٢٣٤-٥٦٧٨"), "201012345678");
  assert.equal(normalizeSearchDigits("۰۱۰۱۲۳۴۵۶۷۸"), "01012345678");
  assert.equal(normalizeSearchDigits("Mona 123"), "123");
});
