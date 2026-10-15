export type BusinessHours = {
  businessHoursEnabled: boolean;
  businessDays: string[];
  businessStart: string;
  businessEnd: string;
};

function minutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  return hours <= 23 && mins <= 59 ? hours * 60 + mins : null;
}

export function isWithinBusinessHours(settings: BusinessHours, now = new Date()) {
  if (!settings.businessHoursEnabled) return true;
  const start = minutes(settings.businessStart);
  const end = minutes(settings.businessEnd);
  if (start === null || end === null) return false;

  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = values.weekday.toUpperCase();
  const todayMinutes = Number(values.hour) * 60 + Number(values.minute);
  const workDays = new Set(settings.businessDays);
  if (start === end) return workDays.has(day);
  if (start < end) return workDays.has(day) && todayMinutes >= start && todayMinutes < end;
  const previousDay = new Date(now.getTime() - 24 * 60 * 60_000);
  const previousName = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "long" }).format(previousDay).toUpperCase();
  return workDays.has(day) && todayMinutes >= start || workDays.has(previousName) && todayMinutes < end;
}
