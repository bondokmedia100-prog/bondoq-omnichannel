import assert from "node:assert/strict";
import test from "node:test";
import { isWithinBusinessHours } from "./businessHours";

const settings = { businessHoursEnabled: true, businessDays: ["MONDAY"], businessStart: "09:00", businessEnd: "17:00" };

test("checks configured days and Cairo local hours", () => {
  assert.equal(isWithinBusinessHours(settings, new Date("2026-10-12T07:00:00.000Z")), true);
  assert.equal(isWithinBusinessHours(settings, new Date("2026-10-12T15:30:00.000Z")), false);
  assert.equal(isWithinBusinessHours(settings, new Date("2026-10-13T08:00:00.000Z")), false);
});

test("accepts an overnight work window spanning selected days", () => {
  const overnight = { ...settings, businessStart: "22:00", businessEnd: "02:00" };
  assert.equal(isWithinBusinessHours(overnight, new Date("2026-10-12T21:30:00.000Z")), true);
  assert.equal(isWithinBusinessHours(overnight, new Date("2026-10-12T22:30:00.000Z")), true);
  assert.equal(isWithinBusinessHours(overnight, new Date("2026-10-12T23:30:00.000Z")), false);
});

test("distinguishes morning hours from a shift that runs past midnight", () => {
  const morning = { ...settings, businessStart: "01:15", businessEnd: "09:00" };
  const overnight = { ...settings, businessStart: "09:00", businessEnd: "01:15" };
  const lateMonday = new Date("2026-10-12T20:05:00.000Z");

  assert.equal(isWithinBusinessHours(morning, lateMonday), false);
  assert.equal(isWithinBusinessHours(overnight, lateMonday), true);
  assert.equal(isWithinBusinessHours(overnight, new Date("2026-10-12T22:00:00.000Z")), true);
  assert.equal(isWithinBusinessHours(overnight, new Date("2026-10-12T22:30:00.000Z")), false);
});
