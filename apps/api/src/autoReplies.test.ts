import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_REPLY_MENU_TEXT, DEFAULT_CHATBOT_SETTINGS, buildBranchReplyText, buildRoutingMenuText, decideBotAction, findMatchingAutoReply, getServiceChoice } from "./autoReplies";

test("matches Arabic keywords without diacritics", () => {
  const rules = [{ keywords: ["توصيل"], responseText: "سنساعدك", routingDepartment: "DELIVERY" }];
  assert.equal(findMatchingAutoReply(rules, "أريد التَّوْصيل من فضلك"), rules[0]);
});

test("does not match empty keywords or empty messages", () => {
  const rules = [{ keywords: [""], responseText: "irrelevant" }];
  assert.equal(findMatchingAutoReply(rules, "مرحبًا"), undefined);
  assert.equal(findMatchingAutoReply(rules, "  "), undefined);
});

test("maps Arabic and Western service numbers to configured options", () => {
  assert.equal(getServiceChoice("١")?.label, "الفروع ومواعيد العمل");
  assert.equal(getServiceChoice("2.")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("٣")?.routingDepartment, "HEADQUARTERS");
  assert.equal(getServiceChoice("رقم ٤")?.routingDepartment, "QUALITY");
  assert.equal(getServiceChoice("route_other")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("السلام عليكم"), undefined);
  assert.equal(getServiceChoice("رقم 6"), undefined);
});

test("first contact only displays the menu and remains in BOT_MENU", () => {
  assert.deepEqual(decideBotAction({ enabled: true, state: "ASSIGNED_TO_AGENT", starting: true, text: "السلام عليكم", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "MENU", nextState: "BOT_MENU" });
});

test("invalid replies remain in BOT_MENU without handing off", () => {
  assert.deepEqual(decideBotAction({ enabled: true, state: "BOT_MENU", starting: false, text: "السلام عليكم", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "INVALID", nextState: "BOT_MENU" });
});

test("branches reply keeps the customer in BOT_MENU", () => {
  const decision = decideBotAction({ enabled: true, state: "BOT_MENU", starting: false, text: "١", settings: DEFAULT_CHATBOT_SETTINGS });
  assert.equal(decision.action, "BRANCHES");
  assert.equal(decision.nextState, "BOT_MENU");
  assert.match(buildBranchReplyText(DEFAULT_CHATBOT_SETTINGS), /أرسل الرقم 2/);
});

test("choices 2 to 5 hand off with the configured department", () => {
  const decision = decideBotAction({ enabled: true, state: "BOT_MENU", starting: false, text: "٣", settings: DEFAULT_CHATBOT_SETTINGS });
  assert.equal(decision.action, "HANDOFF");
  assert.equal(decision.nextState, "ASSIGNED_TO_AGENT");
  if (decision.action === "HANDOFF") assert.equal(decision.choice.label, "طلبات الجملة");
});

test("disabled bot bypasses the menu", () => {
  assert.deepEqual(decideBotAction({ enabled: false, state: "BOT_MENU", starting: false, text: "١", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "BYPASS", nextState: "ASSIGNED_TO_AGENT" });
});

test("disabled bot does not unassign an active agent conversation", () => {
  assert.deepEqual(decideBotAction({ enabled: false, state: "ASSIGNED_TO_AGENT", starting: false, text: "أحتاج مساعدة", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "NONE", nextState: "ASSIGNED_TO_AGENT" });
});

test("builds the configured menu and branch response", () => {
  assert.equal(AUTO_REPLY_MENU_TEXT, "أهلاً بك في حلواني بندق.\nيرجى اختيار رقم الخدمة المطلوبة:\n1. الفروع ومواعيد العمل\n2. خدمة العملاء\n3. طلبات الجملة\n4. الشكاوى والاقتراحات\n5. غير ذلك");
  const settings = { ...DEFAULT_CHATBOT_SETTINGS, welcomeText: "مرحبًا", option1ReplyText: "وسط البلد: 10 ص إلى 10 م" };
  assert.equal(buildRoutingMenuText(settings).split("\n")[0], "مرحبًا");
  assert.equal(buildBranchReplyText(settings), "وسط البلد: 10 ص إلى 10 م\n\nللتحدث مع ممثل خدمة العملاء أرسل الرقم 2.");
});
