import { test } from "node:test";
import assert from "node:assert/strict";
import { detectQuota, parseResetText } from "../src/quota.ts";

const NOW = new Date("2026-10-18T10:00:00Z");

test("pas de faux positif sur une sortie normale", () => {
  assert.equal(detectQuota('{"type":"result","subtype":"success","result":"Verdict enregistré."}', NOW), null);
});

test("session limit avec heure et fuseau IANA", () => {
  const hit = detectQuota("You've hit your session limit · resets 3pm (Europe/Paris)", NOW);
  assert.ok(hit);
  assert.equal(hit.parsed, true);
  // 15h à Paris le 18 oct. 2026 (UTC+2) = 13h UTC
  assert.equal(hit.resetsAt, "2026-10-18T13:00:00.000Z");
});

test("apostrophe typographique et ligne JSON échappée", () => {
  const line = JSON.stringify({ type: "result", is_error: true, result: "You’ve hit your weekly limit · resets Oct 20, 5am (UTC)" });
  const hit = detectQuota(line, NOW);
  assert.ok(hit);
  assert.equal(hit.resetsAt, "2026-10-20T05:00:00.000Z");
});

test("limite Opus / Sonnet détectée", () => {
  assert.ok(detectQuota("You've hit your Sonnet limit. resets 11:30pm", NOW));
  assert.ok(detectQuota("You've hit your opus limit", NOW));
});

test("heure déjà passée aujourd'hui → demain", () => {
  const d = parseResetText("9am", NOW);
  assert.equal(d?.toISOString(), "2026-10-19T09:00:00.000Z");
});

test("délai relatif", () => {
  assert.equal(parseResetText("in 2h 30m", NOW)?.toISOString(), "2026-10-18T12:30:00.000Z");
  assert.equal(parseResetText("in 45 minutes", NOW)?.toISOString(), "2026-10-18T10:45:00.000Z");
});

test("ancien format epoch (secondes)", () => {
  const hit = detectQuota("Claude AI usage limit reached|1760000000", NOW);
  assert.equal(hit?.resetsAt, new Date(1760000000 * 1000).toISOString());
});

test("heure illisible → repli maintenant + 1 h, toujours ISO", () => {
  const hit = detectQuota("You've hit your session limit · resets soon-ish", NOW);
  assert.ok(hit);
  assert.equal(hit.parsed, false);
  assert.equal(hit.resetsAt, "2026-10-18T11:00:00.000Z");
});

test("sans « resets » → repli", () => {
  const hit = detectQuota("Claude usage limit reached. Try again later.", NOW);
  assert.ok(hit);
  assert.equal(hit.parsed, false);
  assert.ok(!Number.isNaN(new Date(hit.resetsAt).getTime()));
});
