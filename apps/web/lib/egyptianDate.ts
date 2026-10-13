const timeZone = "Africa/Cairo";

function cairoOffsetMilliseconds(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(instant).reduce((result, part) => ({ ...result, [part.type]: part.value }), {} as Record<string, string>);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(instant.getTime() / 1000) * 1000;
}

export function formatCairoDateTime(value?: string | Date | null, includeTime = true) {
  if (!value) return "غير محدد";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "غير محدد";
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone, dateStyle: "medium", ...(includeTime ? { timeStyle: "short" as const } : {})
  }).format(date);
}

export function formatCairoTime(value?: string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ar-EG", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}

export function cairoInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const [date, time = "00:00"] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = localAsUtc;
  for (let i = 0; i < 2; i++) instant = localAsUtc - cairoOffsetMilliseconds(new Date(instant));
  return new Date(instant).toISOString();
}
