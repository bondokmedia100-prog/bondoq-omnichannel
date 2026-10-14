import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_REPLY_HANDOFF_TEXT, AUTO_REPLY_MENU_TEXT, findMatchingAutoReply, getServiceChoice } from "./autoReplies";

test("matches Arabic keywords without diacritics", () => {
  const rules = [{ keywords: ["توصيل"], responseText: "سنساعدك", routingDepartment: "DELIVERY" }];
  assert.equal(findMatchingAutoReply(rules, "أريد التَّوْصيل من فضلك"), rules[0]);
});

test("does not match empty keywords or empty messages", () => {
  const rules = [{ keywords: [""], responseText: "irrelevant" }];
  assert.equal(findMatchingAutoReply(rules, "مرحبًا"), undefined);
  assert.equal(findMatchingAutoReply(rules, "  "), undefined);
});

test("maps Arabic and Western service numbers to the six Bondoq queues", () => {
  assert.equal(getServiceChoice("١")?.label, "الفروع");
  assert.equal(getServiceChoice("2.")?.label, "طلب أوردر جديد");
  assert.equal(getServiceChoice("رقم ٤")?.routingDepartment, "QUALITY");
  assert.equal(getServiceChoice("route_wholesale")?.label, "طلبات الجملة");
  assert.equal(getServiceChoice("السلام عليكم"), undefined);
  assert.equal(getServiceChoice("رقم 7"), undefined);
});

test("uses the approved customer-facing menu and handoff text", () => {
  assert.match(AUTO_REPLY_MENU_TEXT, /6\. طلبات الجملة/);
  assert.equal(AUTO_REPLY_HANDOFF_TEXT, "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء.");
});
