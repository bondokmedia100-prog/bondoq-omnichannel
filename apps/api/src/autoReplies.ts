export type AutoReplyRuleMatch = {
  keywords: string[];
  responseText: string;
  routingDepartment?: string | null;
};

function normalizeArabic(value: string) {
  return value.toLocaleLowerCase("ar-EG").replace(/[\u064B-\u065F\u0670ـ]/g, "").replace(/\s+/g, " ").trim();
}

export function findMatchingAutoReply<T extends AutoReplyRuleMatch>(rules: T[], text?: string) {
  if (!text?.trim()) return undefined;
  const normalizedText = normalizeArabic(text);
  return rules.find((rule) => rule.keywords.some((keyword) => {
    const normalizedKeyword = normalizeArabic(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  }));
}
