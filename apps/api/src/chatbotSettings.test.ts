import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHATBOT_SETTINGS } from "./autoReplies";
import { migrateLegacyChatbotSettings } from "./chatbotSettings";

test("migrates old chatbot defaults but keeps customized copy", () => {
  const oldGenericReply = "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء المختص.";
  const existing = {
    ...DEFAULT_CHATBOT_SETTINGS,
    welcomeText: "أهلاً بك في حلواني بندق.",
    option1Label: "الفروع ومواعيد العمل",
    option3Label: "طلبات الجملة",
    option4Label: "الشكاوى والاقتراحات",
    option1ReplyText: oldGenericReply,
    option2ReplyText: "رد مخصص لخدمة العملاء",
    option3ReplyText: oldGenericReply,
    option4ReplyText: oldGenericReply,
    option5ReplyText: oldGenericReply
  };
  assert.deepEqual(migrateLegacyChatbotSettings(existing), {
    welcomeText: DEFAULT_CHATBOT_SETTINGS.welcomeText,
    option1Label: DEFAULT_CHATBOT_SETTINGS.option1Label,
    option3Label: DEFAULT_CHATBOT_SETTINGS.option3Label,
    option4Label: DEFAULT_CHATBOT_SETTINGS.option4Label,
    option1ReplyText: DEFAULT_CHATBOT_SETTINGS.option1ReplyText,
    option3ReplyText: DEFAULT_CHATBOT_SETTINGS.option3ReplyText,
    option4ReplyText: DEFAULT_CHATBOT_SETTINGS.option4ReplyText,
    option5ReplyText: DEFAULT_CHATBOT_SETTINGS.option5ReplyText
  });
});

test("corrects the saved business-hours range shown in the settings screenshot", () => {
  const existing = {
    ...DEFAULT_CHATBOT_SETTINGS,
    businessHoursEnabled: true,
    businessStart: "01:15",
    businessEnd: "09:00"
  };

  assert.deepEqual(migrateLegacyChatbotSettings(existing), {
    businessStart: "09:00",
    businessEnd: "01:00"
  });
});

test("leaves disabled or otherwise customized business-hours ranges unchanged", () => {
  const disabled = { ...DEFAULT_CHATBOT_SETTINGS, businessHoursEnabled: false, businessStart: "01:15", businessEnd: "09:00" };
  const customized = { ...DEFAULT_CHATBOT_SETTINGS, businessHoursEnabled: true, businessStart: "10:00", businessEnd: "18:00" };

  assert.deepEqual(migrateLegacyChatbotSettings(disabled), {});
  assert.deepEqual(migrateLegacyChatbotSettings(customized), {});
});
