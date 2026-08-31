#!/usr/bin/env node
/**
 * Parse le execution_file de claude-code-action et POST la consommation tokens
 * à feedback-app (/api/agent-callback/usage), qui calcule le coût et persiste
 * en DB.
 *
 * ⚠️ Ne calcule PAS le coût et n'écrit AUCUN fichier (contrairement à l'ancien
 * scripts/parse-claude-execution.ts de cockpit qui commitait .claude/usage/*.jsonl
 * dans le repo cible). Le coût € est calculé côté feedback-app — table de prix
 * unique. Ici on n'envoie que les tokens bruts + le modèle.
 *
 * Tolérant : tout problème (fichier manquant, JSON invalide, réseau) → warn +
 * exit 0. Le tracking d'usage ne doit JAMAIS casser le pipeline.
 *
 * CommonJS (`.cjs`) + `http(s)` natif au lieu de `fetch` — délibéré. Les
 * runners self-hosted Coolify ne garantissent PAS un `node` moderne dans le
 * `PATH` (vu en prod : un `node` sans support ESM, plantant sur `import … from`
 * avec `SyntaxError: Unexpected token {` avant même d'atteindre `fetch`).
 * `require()` + `http`/`https` fonctionnent sur n'importe quelle version de
 * Node — ce script n'a aucun besoin d'API récente.
 *
 * IMPORTANT (comptage correct) : claude-code-action réutilise le même chemin
 * execution_file entre invocations. Appeler ce script juste après CHAQUE step
 * claude, avec le steps.<id>.outputs.execution_file de CE step, et AVANT que le
 * step claude suivant n'écrase le fichier. Sinon les tokens d'un modèle sont
 * recomptés pour un autre (ex. validate Sonnet attribué à implement Opus).
 *
 * Env attendues :
 *   EXEC_FILE             chemin du execution_file (steps.<id>.outputs.execution_file)
 *   ISSUE_NUM             numéro d'issue GitHub
 *   WORKFLOW_NAME         ex. "Claude Plan"
 *   STEP_NAME             ex. "plan" | "validate" | "implement"
 *   RUN_ID               github.run_id
 *   CLAUDE_MODEL          modèle du step (Sonnet pour validate, Opus pour implement…)
 *   REPO                 owner/repo (github.repository du repo cible)
 *   FEEDBACK_APP_URL     base URL feedback-app
 *   AGENT_CALLBACK_SECRET bearer secret
 */

const { existsSync, readFileSync } = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

function warn(msg) {
  process.stderr.write(`[report-usage] ${msg}\n`);
}

/**
 * POST JSON minimal via http(s) natif (pas de `fetch` — indisponible sur les
 * Node pré-18 qu'on peut rencontrer sur un runner self-hosted mal à jour).
 * Résout avec { ok, status, body } comme un `Response` simplifié ; ne rejette
 * jamais pour une erreur réseau (résolu avec ok:false à la place) — l'appelant
 * reste tolérant sans avoir à distinguer try/catch réseau vs statut HTTP.
 */
function postJson(urlStr, payload, headers) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, status: 0, body: `URL invalide: ${e.message}` });
      return;
    }
    const body = JSON.stringify(payload);
    const client = url.protocol === "http:" ? http : https;
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, body: text });
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

/**
 * Agrège les tokens des turns `assistant` (message.usage) et lit la durée du
 * turn `result`. Tolérant : retourne des zéros si le fichier est absent/invalide.
 */
function parseTokens(path) {
  const empty = {
    model: process.env.CLAUDE_MODEL || "",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
  };
  if (!path || !existsSync(path)) {
    warn(`execution_file absent: ${path}`);
    return empty;
  }
  let turns;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    turns = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    warn(`JSON invalide dans ${path}: ${e.message}`);
    return empty;
  }

  let model = process.env.CLAUDE_MODEL || "";
  let input = 0;
  let output = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let durationMs = 0;

  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    if (!model) model = turn.message?.model || turn.model || "";
    if (turn.type === "assistant" && turn.message?.usage) {
      const u = turn.message.usage;
      input += Number(u.input_tokens || 0);
      output += Number(u.output_tokens || 0);
      cacheCreate += Number(u.cache_creation_input_tokens || 0);
      cacheRead += Number(u.cache_read_input_tokens || 0);
    }
    if (turn.type === "result" && typeof turn.duration_ms === "number") {
      durationMs = turn.duration_ms;
    }
  }

  return {
    model: model || process.env.CLAUDE_MODEL || "",
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    durationMs,
  };
}

async function main() {
  const base = process.env.FEEDBACK_APP_URL;
  const secret = process.env.AGENT_CALLBACK_SECRET;
  if (!base || !secret) {
    warn("FEEDBACK_APP_URL / AGENT_CALLBACK_SECRET manquants — skip");
    return;
  }
  const repo = process.env.REPO || "";
  const [owner, ...rest] = repo.split("/");
  const name = rest.join("/");
  if (!owner || !name) {
    warn(`REPO invalide (attendu owner/repo): "${repo}" — skip`);
    return;
  }

  const tokens = parseTokens(process.env.EXEC_FILE || "");
  const total =
    tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (total === 0) {
    warn(`0 token parsé (step=${process.env.STEP_NAME}) — skip POST`);
    return;
  }

  const payload = {
    repo: { owner, name },
    ghIssueNumber: Number(process.env.ISSUE_NUM || 0),
    runId: process.env.RUN_ID || "unknown",
    workflow: process.env.WORKFLOW_NAME || "unknown",
    step: process.env.STEP_NAME || "unknown",
    model: tokens.model,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    durationMs: tokens.durationMs,
  };

  const res = await postJson(`${base.replace(/\/$/, "")}/api/agent-callback/usage`, payload, {
    authorization: `Bearer ${secret}`,
  });
  if (!res.ok) {
    warn(`POST usage ${res.status}: ${res.body.slice(0, 200)}`);
    return;
  }
  warn(`usage envoyé: ${total} tokens (${payload.model}, step=${payload.step})`);
}

main().catch((e) => {
  warn(`erreur inattendue: ${e.message}`);
  process.exit(0);
});
