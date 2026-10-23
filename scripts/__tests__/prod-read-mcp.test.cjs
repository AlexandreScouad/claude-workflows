// Test du serveur MCP prod_read : handshake stdio + relais vers un faux
// serveur Feedback App. Lancer : node --test scripts/__tests__/prod-read-mcp.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const TOKEN = "jeton-de-test-123";

function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ success: false, error: "Session de lecture invalide, expirée ou révoquée." }));
      }
      const parsed = JSON.parse(body);
      if (parsed.sql && /client_secret/.test(parsed.sql)) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ success: false, error: "permission denied for table x" }));
      }
      const rows = parsed.kind === "views" ? [{ vue: "orders", colonnes: "id integer, status text" }] : [{ n: 37 }];
      res.end(JSON.stringify({ success: true, data: { rows, truncated: false, remaining: 39 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

function runMcp(env, messages) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "prod-read-mcp.cjs")], {
      env: { PATH: process.env.PATH, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const expected = messages.filter((m) => m.id !== undefined).length;
    const check = setInterval(() => {
      const lines = out.split("\n").filter(Boolean);
      if (lines.length >= expected) {
        clearInterval(check);
        child.stdin.end();
      }
    }, 20);
    child.on("exit", () => resolve({ responses: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr: err }));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("handshake, liste des outils, relais des appels", async () => {
  const { server, seen, port } = await startStub();
  try {
    const { responses, stderr } = await runMcp(
      { FEEDBACK_APP_URL: `http://127.0.0.1:${port}/`, PROD_READ_TOKEN: TOKEN },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lister_vues_agent", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lecture_prod", arguments: { sql: "select count(*) as n from agent.orders" } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lecture_prod", arguments: { sql: "select * from client_secret" } } },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lecture_prod", arguments: {} } },
        { jsonrpc: "2.0", id: 7, method: "resources/list" },
      ],
    );
    const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
    assert.equal(responses.length, 7, "une réponse par requête, aucune pour la notification");
    assert.equal(byId[1].result.serverInfo.name, "prod_read");
    assert.deepEqual(byId[1].result.capabilities, { tools: {} });
    assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["lister_vues_agent", "lecture_prod"]);
    assert.equal(byId[3].result.isError, false);
    assert.match(byId[3].result.content[0].text, /NON FIABLE[\s\S]*orders/);
    assert.equal(byId[4].result.isError, false);
    assert.match(byId[4].result.content[0].text, /1 ligne\(s\) — requêtes restantes : 39[\s\S]*"n": 37/);
    assert.equal(byId[5].result.isError, true);
    assert.match(byId[5].result.content[0].text, /permission denied/);
    assert.equal(byId[6].result.isError, true);
    assert.equal(byId[7].error.code, -32601);
    assert.equal(stderr, "", "rien sur stderr (logs publics)");
    assert.ok(seen.every((s) => s.url === "/api/agent-callback/prod-read/query" && s.auth === `Bearer ${TOKEN}`));
    assert.deepEqual(seen[0].body, { kind: "views" });
    assert.equal(seen.length, 3, "l'appel sans sql n'atteint pas le serveur");
  } finally {
    server.close();
  }
});

test("sans jeton : échec propre, aucun appel réseau", async () => {
  const { responses, stderr } = await runMcp({ FEEDBACK_APP_URL: "http://127.0.0.1:9" }, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lecture_prod", arguments: { sql: "select 1" } } },
  ]);
  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.content[0].text, /non configurée/);
  assert.equal(stderr, "");
});
