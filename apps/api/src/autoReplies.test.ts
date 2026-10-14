import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_REPLY_HANDOFF_TEXT, AUTO_REPLY_MENU_TEXT, buildRoutingMenuText, findMatchingAutoReply, getServiceChoice } from "./autoReplies";

test("matches Arabic keywords without diacritics", () => {
  const rules = [{ keywords: ["توصيل"], responseText: "سنساعدك", routingDepartment: "DELIVERY" }];
  assert.equal(findMatchingAutoReply(rules, "أريد التَّوْصيل من فضلك"), rules[0]);
});

test("does not match empty keywords or empty messages", () => {
  const rules = [{ keywords: [""], responseText: "irrelevant" }];
  assert.equal(findMatchingAutoReply(rules, "مرحبًا"), undefined);
  assert.equal(findMatchingAutoReply(rules, "  "), undefined);
});

test("maps Arabic and Western service numbers to the five screenshot queues", () => {
  assert.equal(getServiceChoice("١")?.label, "الفروع");
  assert.equal(getServiceChoice("2.")?.label, "خدمة العملاء");
  assert.equal(getServiceChoice("٣")?.routingDepartment, "HEADQUARTERS");
  assert.equal(getServiceChoice("رقم ٤")?.routingDepartment, "QUALITY");
  assert.equal(getServiceChoice("route_other")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("route_delivery")?.routingDepartment, "DELIVERY");
  assert.equal(getServiceChoice("السلام عليكم"), undefined);
  assert.equal(getServiceChoice("رقم 6"), undefined);
});

test("uses the approved customer-facing menu and handoff text", () => {
  assert.equal(AUTO_REPLY_MENU_TEXT, "أهلاً بك في حلواني بندق، برجاء اختيار الخدمة المطلوبة بإرسال رقم الخدمة:\n1. الفروع\n2. خدمة العملاء\n3. طلبات الجملة\n4. الشكاوى والاقتراحات\n5. غير ذلك");
  assert.equal(AUTO_REPLY_HANDOFF_TEXT, "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء.");
});

test("uses a saved welcome message before the service choices", () => {
  const menu = buildRoutingMenuText("مرحبًا بكم في بندق");
  assert.equal(menu, `مرحبًا بكم في بندق\n${AUTO_REPLY_MENU_TEXT.split("\n").slice(1).join("\n")}`);
  assert.equal(buildRoutingMenuText("  "), AUTO_REPLY_MENU_TEXT);
});
