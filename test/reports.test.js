import { test } from "node:test";
import assert from "node:assert/strict";
import { periodRange, periodLabel, summarise } from "../lib/reports.js";

test("weekly periods run Monday to Monday (UTC)", () => {
  assert.deepEqual(periodRange("weekly", "2026-11-23T06:00:00Z"), { start: "2026-11-23", end: "2026-11-30" }); // Monday
  assert.deepEqual(periodRange("weekly", "2026-11-29T23:59:59Z"), { start: "2026-11-23", end: "2026-11-30" }); // Sunday
  assert.deepEqual(periodRange("weekly", "2027-01-01"), { start: "2026-12-28", end: "2027-01-04" });          // crosses the year
});

test("calendar periods", () => {
  const d = "2026-08-15T12:00:00Z";
  assert.deepEqual(periodRange("monthly", d), { start: "2026-08-01", end: "2026-09-01" });
  assert.deepEqual(periodRange("quarterly", d), { start: "2026-07-01", end: "2026-10-01" });
  assert.deepEqual(periodRange("half_yearly", d), { start: "2026-07-01", end: "2027-01-01" });
  assert.deepEqual(periodRange("yearly", d), { start: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(periodRange("monthly", "2026-12-31"), { start: "2026-12-01", end: "2027-01-01" });
  assert.deepEqual(periodRange("half_yearly", "2026-06-30"), { start: "2026-01-01", end: "2026-07-01" });
});

test("labels", () => {
  assert.equal(periodLabel("weekly", "2026-11-23"), "Week of 23 Nov 2026");
  assert.equal(periodLabel("monthly", "2026-11-01"), "Nov 2026");
  assert.equal(periodLabel("quarterly", "2026-10-01"), "Q4 2026");
  assert.equal(periodLabel("half_yearly", "2026-07-01"), "H2 2026");
  assert.equal(periodLabel("yearly", "2026-01-01"), "2026");
});

const scan = (score, ids, at, speed = 60) => ({
  score, speed, created_at: at,
  issues: JSON.stringify(ids.map(id => ({ id, label: id.toUpperCase(), w: id === "ai" ? 15 : 10, fix: `fix ${id}` }))),
});

test("summarise compares against the scan before the period", () => {
  const baseline = scan(40, ["ai", "llms", "title"], "2026-10-28T06:00:00Z");
  const s = summarise([
    scan(55, ["ai", "llms"], "2026-11-02T06:00:00Z"),
    scan(70, ["llms", "speed"], "2026-11-09T06:00:00Z", 50),
  ], baseline);
  assert.equal(s.score_start, 40);
  assert.equal(s.score_end, 70);
  assert.equal(s.score_avg, 63);
  assert.equal(s.score_min, 55);
  assert.equal(s.score_max, 70);
  assert.equal(s.speed_avg, 55);
  assert.deepEqual(s.summary.resolved.sort(), ["AI", "TITLE"]);
  assert.deepEqual(s.summary.new, ["SPEED"]);
  assert.equal(s.issues_open, 2);
  assert.equal(s.summary.persistent[0].label, "LLMS"); // failed in both scans
  assert.equal(s.summary.trend.length, 2);
});

test("summarise without a baseline starts from the first scan", () => {
  const s = summarise([scan(50, ["ai"], "2026-11-02T06:00:00Z"), scan(50, ["ai"], "2026-11-02T09:00:00Z")], null);
  assert.equal(s.score_start, 50);
  assert.equal(s.issues_resolved, 0);
  assert.equal(s.summary.trend.length, 1); // one point per day
});
