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
