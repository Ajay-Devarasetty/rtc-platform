import test from "node:test";
import assert from "node:assert/strict";
import { currentMonth, durationInPeriod } from "./usage-period.js";
test("monthly reports use UTC boundaries", () => {
  assert.equal(currentMonth(new Date("2026-03-01T00:01:00Z")).from, "2026-03-01T00:00:00.000Z");
});
test("a call spanning midnight contributes only its overlap with the month", () => {
  const period = { from: "2026-03-01T00:00:00Z", to: "2026-03-01T00:02:00Z" };
  assert.equal(durationInPeriod("2026-02-28T23:59:00Z", "2026-03-01T00:01:00Z", period), 60000);
  assert.equal(durationInPeriod("2026-02-28T23:59:00Z", null, period, Date.parse(period.to)), 120000);
  assert.equal(durationInPeriod("2026-02-28T23:58:00Z", "2026-02-28T23:59:00Z", period), 0);
});
