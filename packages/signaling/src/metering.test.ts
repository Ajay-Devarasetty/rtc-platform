import test from "node:test";
import assert from "node:assert/strict";
import { startCallSession, endCallSession, getMeteringSummary } from "./metering.js";

test("live calls accrue usage and duplicate end events do not extend the duration", async (t) => {
  assert.equal(process.env.DATABASE_URL, undefined, "This regression test must use the in-memory store");
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  await startCallSession("meter-test", "c", "r", "alice", "bob");
  t.mock.timers.tick(90_000);
  assert.equal((await getMeteringSummary("meter-test")).callMinutes, 1.5);
  await endCallSession("meter-test", "c");
  t.mock.timers.tick(60_000);
  await endCallSession("meter-test", "c");
  const result = await getMeteringSummary("meter-test");
  assert.equal(result.callMinutes, 1.5);
  assert.equal(result.callsEnded, 1);
  assert.equal((await getMeteringSummary("other")).callMinutes, 0);
});
