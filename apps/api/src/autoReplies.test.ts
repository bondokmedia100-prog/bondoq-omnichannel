import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_REPLY_MENU_TEXT, BOT_MENU_IDLE_TIMEOUT_MS, DEFAULT_CHATBOT_SETTINGS, buildRoutingMenuText, decideBotAction, findMatchingAutoReply, getServiceChoice, isBotMenuIdleExpired } from "./autoReplies";

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
  assert.equal(getServiceChoice("١")?.label, "الفروع");
  assert.equal(getServiceChoice("2.")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("٣")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("رقم ٤")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("5")?.routingDepartment, "CUSTOMER_CARE");
  assert.equal(getServiceChoice("رقم ٤")?.isComplaint, true);
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

test("first menu selection hands off to customer care", () => {
  const decision = decideBotAction({ enabled: true, state: "BOT_MENU", starting: false, text: "١", settings: DEFAULT_CHATBOT_SETTINGS });
  assert.equal(decision.action, "HANDOFF");
  assert.equal(decision.nextState, "ASSIGNED_TO_AGENT");
  if (decision.action === "HANDOFF") assert.equal(decision.choice.routingDepartment, "CUSTOMER_CARE");
});

test("all menu options hand off to customer care and keep complaints flagged", () => {
  for (const number of ["1", "2", "3", "4", "5"]) {
    const decision = decideBotAction({ enabled: true, state: "BOT_MENU", starting: false, text: number, settings: DEFAULT_CHATBOT_SETTINGS });
    assert.equal(decision.action, "HANDOFF");
    if (decision.action === "HANDOFF") {
      assert.equal(decision.choice.routingDepartment, "CUSTOMER_CARE");
      assert.equal(decision.choice.isComplaint, number === "4");
    }
  }
});

test("disabled bot bypasses the menu", () => {
  assert.deepEqual(decideBotAction({ enabled: false, state: "BOT_MENU", starting: false, text: "١", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "BYPASS", nextState: "ASSIGNED_TO_AGENT" });
});

test("disabled bot does not unassign an active agent conversation", () => {
  assert.deepEqual(decideBotAction({ enabled: false, state: "ASSIGNED_TO_AGENT", starting: false, text: "أحتاج مساعدة", settings: DEFAULT_CHATBOT_SETTINGS }), { action: "NONE", nextState: "ASSIGNED_TO_AGENT" });
});

test("builds the configured menu", () => {
  assert.equal(AUTO_REPLY_MENU_TEXT, "برجاء اختيار الاختيار المناسب لحضرتك\n1 الفروع\n2 خدمة العملاء\n3 طلبات الجمله\n4 الشكاوي والاقتراحات\n5 غير ذلك");
  const settings = { ...DEFAULT_CHATBOT_SETTINGS, welcomeText: "مرحبًا", option1ReplyText: "وسط البلد: 10 ص إلى 10 م" };
  assert.equal(buildRoutingMenuText(settings).split("\n")[0], "مرحبًا");
});

test("uses a different waiting message for each menu option", () => {
  const replies = [1, 2, 3, 4, 5].map((number) => DEFAULT_CHATBOT_SETTINGS[`option${number}ReplyText` as keyof typeof DEFAULT_CHATBOT_SETTINGS]);
  assert.equal(new Set(replies).size, 5);
});

test("invalid menu choice uses the requested correction message", () => {
  assert.equal(DEFAULT_CHATBOT_SETTINGS.invalidChoiceText, "عذرًا، يرجى إرسال رقم الاختيار المطلوب فقط (من 1 إلى 5) لنتمكن من توجيهك للقسم الصحيح.");
});

test("bot menu expires after one hour of inactivity", () => {
  const lastInboundAt = new Date("2026-10-16T00:00:00.000Z");
  assert.equal(isBotMenuIdleExpired("BOT_MENU", lastInboundAt, new Date(lastInboundAt.getTime() + BOT_MENU_IDLE_TIMEOUT_MS - 1)), false);
  assert.equal(isBotMenuIdleExpired("BOT_MENU", lastInboundAt, new Date(lastInboundAt.getTime() + BOT_MENU_IDLE_TIMEOUT_MS)), true);
  assert.equal(isBotMenuIdleExpired("ASSIGNED_TO_AGENT", lastInboundAt, new Date(lastInboundAt.getTime() + BOT_MENU_IDLE_TIMEOUT_MS)), false);
});
