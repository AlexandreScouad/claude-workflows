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
 *
 * Détection limite d'usage (abonnement Claude, cf. investigation COCKP-1237) :
 * en plus des tokens, on scanne `execution_file` pour des messages
 * `rate_limit_event` (SDKRateLimitEvent — @anthropic-ai/claude-agent-sdk) et
 * des erreurs de turn `rate_limit`/`overloaded`/`billing_error`/
 * `account_on_hold`. C'est le SEUL endroit où ce signal est observable :
 * `execution_file` vit sur le runner éphémère et n'est jamais persisté
 * ailleurs — feedback-app ne peut pas le relire après coup. Si trouvé
 * (status `allowed_warning`/`rejected`), posté à part dans le payload
 * (`usageLimit`) pour finir dans l'historique du ticket, même quand 0 token
 * n'a été consommé (un `rejected` bloque souvent l'appel AVANT toute
 * consommation).
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
 * Charge et parse `execution_file`. `[]` si absent/invalide (tolérant —
 * chaque appelant retombe sur son propre défaut).
 */
function loadTurns(path) {
  if (!path || !existsSync(path)) {
    warn(`execution_file absent: ${path}`);
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    warn(`JSON invalide dans ${path}: ${e.message}`);
    return [];
  }
}

/** Normalise `resetsAt` (SDK : epoch en secondes OU millisecondes selon la
 * source) en ISO string. Heuristique standard : sous 10^12 → secondes. */
function normalizeResetsAt(resetsAt) {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const CONCERNING_ASSISTANT_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "billing_error",
  "account_on_hold",
]);

/**
 * Scanne les turns pour un signal de limite d'usage à conserver :
 * - le DERNIER `rate_limit_event` dont `status` est `allowed_warning`/`rejected`
 *   (le SDK émet aussi des événements `allowed` purement informatifs, à
 *   ignorer — sinon chaque run "sain" polluerait l'historique du ticket) ;
 * - toute erreur de turn assistant dans `CONCERNING_ASSISTANT_ERRORS`.
 * `null` si rien de notable (cas normal, immense majorité des runs).
 */
function detectUsageLimit(turns) {
  let lastConcerning = null;
  const assistantErrors = [];

  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    if (turn.type === "rate_limit_event" && turn.rate_limit_info) {
      const info = turn.rate_limit_info;
      if (info.status === "allowed_warning" || info.status === "rejected") {
        lastConcerning = info;
      }
    }
    const err = turn.message?.error;
    if (typeof err === "string" && CONCERNING_ASSISTANT_ERRORS.has(err)) {
      assistantErrors.push(err);
    }
  }

  if (!lastConcerning && assistantErrors.length === 0) return null;

  return {
    status: lastConcerning?.status ?? "rejected", // erreur de turn sans rate_limit_event associé → traiter comme rejeté
    rateLimitType: lastConcerning?.rateLimitType ?? null,
    resetsAt: normalizeResetsAt(lastConcerning?.resetsAt),
    errorCode: lastConcerning?.errorCode ?? null,
    assistantErrors: assistantErrors.length > 0 ? assistantErrors : null,
  };
}

/**
 * Agrège les tokens des turns `assistant` (message.usage) et lit la durée du
 * turn `result`.
 */
function parseTokens(turns) {
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

  const turns = loadTurns(process.env.EXEC_FILE || "");
  const tokens = parseTokens(turns);
  const total =
    tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
  const usageLimit = detectUsageLimit(turns);
  if (total === 0 && !usageLimit) {
    warn(`0 token parsé (step=${process.env.STEP_NAME}) — skip POST`);
    return;
  }
  if (usageLimit) {
    warn(
      `limite d'usage détectée (step=${process.env.STEP_NAME}): status=${usageLimit.status} type=${usageLimit.rateLimitType} resetsAt=${usageLimit.resetsAt}`,
    );
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
    ...(usageLimit ? { usageLimit } : {}),
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
