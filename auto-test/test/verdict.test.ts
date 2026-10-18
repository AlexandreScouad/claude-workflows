import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerdictEvent, toWebhookStatus } from "../src/verdict.ts";
import { parseInputs } from "../src/inputs.ts";
import { claudeArgs, claudeEnv } from "../src/claude.ts";

const RUN = "11111111-2222-4333-8444-555555555555";

test("statut de l'outil → statut du webhook", () => {
  assert.equal(toWebhookStatus("ok"), "ok");
  assert.equal(toWebhookStatus("ko"), "ko");
  assert.equal(toWebhookStatus("non_concluant"), "inconclusive");
  assert.equal(toWebhookStatus("n'importe quoi"), "inconclusive");
});

test("événement verdict conforme au webhook", () => {
  const ev = buildVerdictEvent({
    runId: RUN,
    status: "ok",
    summary: "  ",
    reservations: ["cas Occasion non couvert", " "],
    actions: [{ at: "2026-10-18T10:00:00Z", outil: "lire", ok: true }],
    captures: [{ url: "https://x/1.png", label: "Capture 1" }],
    durationMs: 1234.6,
  });
  assert.equal(ev.type, "verdict");
  assert.ok(ev.summary.length > 0, "summary jamais vide");
  assert.deepEqual(ev.reservations, ["cas Occasion non couvert"]);
  assert.equal(ev.turns, 1);
  assert.equal(ev.durationMs, 1235);
  assert.equal("reason" in ev, false);
});

test("entrées du workflow validées", () => {
  const ok = parseInputs({ project_id: RUN, ticket_key: "COCKP-1234", run_id: RUN, head_sha: "abcdef1", forced: true });
  assert.equal(typeof ok, "object");
  assert.equal(typeof ok === "object" && ok.forced, true);
  assert.equal(parseInputs({ project_id: "x", ticket_key: "K", run_id: RUN, head_sha: "abcdef1" }), "project_id invalide");
  assert.equal(parseInputs({ project_id: RUN, ticket_key: "a; rm -rf /", run_id: RUN, head_sha: "abcdef1" }), "ticket_key invalide");
});

test("env de claude : ni clé API, ni secret du webhook", () => {
  const env = claudeEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", AUTO_TEST_WEBHOOK_SECRET: "s", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/bin" }, "/tmp/cfg");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.AUTO_TEST_WEBHOOK_SECRET, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "o");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/cfg");
});

test("arguments de claude : outils fermés, pas de --bare", () => {
  const args = claudeArgs({ prompt: "x", model: "claude-sonnet-5-5", effort: "high", maxTurns: 80, mcpConfig: "/tmp/mcp.json", allowedTools: "mcp__scouad-test__*" });
  const joined = args.join(" ");
  assert.ok(!args.includes("--bare"));
  assert.ok(joined.includes("--model claude-sonnet-5-5 --effort high --max-turns 80"));
  assert.ok(joined.includes("--strict-mcp-config --mcp-config /tmp/mcp.json"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(joined.includes("--allowedTools mcp__scouad-test__* --permission-mode dontAsk --output-format stream-json --verbose"));
  const resume = claudeArgs({ prompt: "y", model: "m", effort: "high", maxTurns: 3, mcpConfig: "/c", allowedTools: "a", resume: "sess-1" });
  assert.ok(resume.join(" ").includes("--max-turns 3 --resume sess-1"));
});

test("ligne de connexion tirée de l'événement init", async () => {
  const { describeInit } = await import("../src/claude.ts");
  const line = describeInit({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    model: "claude-sonnet-5-5",
    mcp_servers: [{ name: "scouad-test", status: "connected" }],
    tools: ["mcp__scouad-test__lire", "mcp__scouad-test__verdict"],
  });
  assert.equal(line, "MCP scouad-test : connected, 2 outil(s) MCP / 2 · apiKeySource none · modèle claude-sonnet-5-5");
});
