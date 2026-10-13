const cairoParts = (date: Date) => Object.fromEntries(
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value])
) as Record<string, string>;

export function startOfCairoDay(now = new Date()): Date {
  const parts = cairoParts(now);
  const localMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  let midnight = localMidnightAsUtc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = new Date(midnight);
    const candidateParts = cairoParts(candidate);
    const localAsUtc = Date.UTC(Number(candidateParts.year), Number(candidateParts.month) - 1, Number(candidateParts.day), Number(candidateParts.hour), Number(candidateParts.minute), Number(candidateParts.second));
    const offset = localAsUtc - Math.floor(candidate.getTime() / 1000) * 1000;
    midnight = localMidnightAsUtc - offset;
  }
  return new Date(midnight);
}
