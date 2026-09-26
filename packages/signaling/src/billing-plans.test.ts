import test from "node:test";
import assert from "node:assert/strict";
import { computeBillingSummary, isBillingPlan, type UsageBreakdown } from "./billing-plans.js";

const usage: UsageBreakdown = {
  callMinutes: 0, messagesSent: 0, recordings: 0, transcriptionMinutes: 0,
  qualityReports: 0, callsConnected: 0, callsEnded: 0, totalEvents: 0,
};

test("usage above a threshold is charged once in the estimate", () => {
  const summary = computeBillingSummary("test", "starter", { ...usage, callMinutes: 1500 });
  assert.equal(summary.estimatedCostUsd, 6);
  assert.equal(summary.overageCostUsd, 2);
  assert.equal(summary.limitStatus.callMinutes.exceeded, true);
});

test("all billable metrics count once and exact thresholds have no overage", () => {
  const summary = computeBillingSummary("test", "starter", {
    ...usage, callMinutes: 1000, messagesSent: 10000, recordings: 100, transcriptionMinutes: 300,
  });
  assert.equal(summary.estimatedCostUsd, 16);
  assert.equal(summary.overageCostUsd, 0);
  assert.equal(summary.limitStatus.callMinutes.exceeded, false);
});

test("free plan usage does not acquire charges", () => {
  const summary = computeBillingSummary("test", "free", { ...usage, messagesSent: 2000 });
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(summary.overageCostUsd, 0);
});

test("only actual plan identifiers are accepted", () => {
  for (const value of ["free", "starter", "pro"]) assert.equal(isBillingPlan(value), true);
  for (const value of ["constructor", "toString", "__proto__", "", null, undefined, {}, ["pro"]]) {
    assert.equal(isBillingPlan(value), false);
  }
});
