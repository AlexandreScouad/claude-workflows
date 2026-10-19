// Runner du test automatique (feedback-app #505), lancé par
// .github/workflows/auto-test.yml.
//
//   contexte → started → claude -p (serveur MCP scouad-test) → verdict
//   ├─ limite de tours sans verdict → reprise --resume (conclusion forcée)
//   │    └─ toujours rien → verdict non concluant « limite de tours »
//   ├─ échéance interne → non concluant « temps dépassé »
//   └─ quota d'abonnement → waiting_quota, sortie 0
//
// DÉPÔT PUBLIC : les logs Actions sont publics. Ce script n'écrit que des
// statuts minimaux ; ni la sortie de l'agent, ni le contexte, ni le résumé du
// verdict. Les chemins d'auto-login sont masqués (::add-mask::) dès réception.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authMethod, claudeArgs, claudeEnv, runClaude, type ClaudeRun } from "./claude.ts";
import {
  AGENT_DEADLINE_MS,
  CONCLUSION_DEADLINE_MS,
  CONCLUSION_MAX_TURNS,
  CONCLUSION_MIN_MS,
  EFFORT,
  MAX_TURNS,
  MCP_SERVER_NAME,
  MODEL,
} from "./config.ts";
import { resolveAccounts } from "./context.ts";
import { fetchContext, postEvent, type FeedbackAppConfig } from "./feedback-app.ts";
import { feedbackAppConfig, readInputs, readRunId, runDirFor, type RunInputs } from "./inputs.ts";
import { buildPrompt, CONCLUSION_PROMPT, TOOL_PREFIX } from "./prompt.ts";
import { ensureRunDir, readTerminal, runPaths, writeRunnerReservations } from "./run-dir.ts";
import { maskCommands, secretValuesOf } from "./sanitize.ts";
import { buildVerdictEvent, deliver, flushPending, sendVerdict } from "./verdict.ts";

const say = (msg: string) => console.log(`[auto-test] ${msg}`);

const CONTEXT_REASONS: Record<string, string> = {
  not_found: "ticket introuvable",
  no_preview: "aucune preview pour ce ticket",
  no_pr: "aucune PR pour ce ticket",
  no_github: "projet sans GitHub",
  no_ai_key: "clé IA absente côté feedback-app (brief)",
  brief_failed: "brief indisponible",
  accounts_unreadable: "comptes de test illisibles",
  invalid_payload: "contexte illisible",
};

async function main(): Promise<number> {
  const startedAt = Date.now();
  const inputs = readInputs(process.env);
  const config = feedbackAppConfig(process.env);
  if (typeof config === "string") {
    say(config);
    return 1;
  }
  if (typeof inputs === "string") {
    say(`entrées invalides : ${inputs}`);
    await rejectInvalidInputs(config, inputs);
    return 1;
  }
  const runDir = runDirFor(process.env, inputs.runId);
  ensureRunDir(runDir);
  const p = runPaths(runDir);
  const send = (status: "ok" | "ko" | "inconclusive", summary: string, reason: string, reservations: string[] = []) =>
    sendVerdict({ config, runDir, projectId: inputs.projectId, runId: inputs.runId, startedAt }, { status, summary, reservations, reason });

  // 1. Préflight auth : doit être le jeton OAuth de l'abonnement.
  const cEnv = claudeEnv(process.env, p.claudeConfig);
  const auth = await authMethod(cEnv, p.work);
  say(`auth Claude Code : ${auth}`);
  if (auth !== "oauth_token") {
    await send("inconclusive", "Le test n'a pas pu démarrer : authentification Claude Code du runner invalide.", "erreur du runner (authentification)");
    return 1;
  }

  // 2. Contexte (masquage immédiat des chemins de connexion).
  const ctx = await fetchContext(config, inputs.projectId, inputs.ticketKey).catch(() => null);
  if (!ctx || !ctx.ok) {
    const code = ctx && !ctx.ok ? ctx.code : null;
    const status = ctx && !ctx.ok ? ctx.status : 0;
    say(`contexte indisponible (HTTP ${status}${code ? `, ${code}` : ""})`);
    const why = (code && CONTEXT_REASONS[code]) || `contexte indisponible (HTTP ${status || "réseau"})`;
    await send("inconclusive", `Le test n'a pas pu démarrer : ${why}.`, why);
    return 0;
  }
  const context = ctx.context;
  for (const line of maskCommands(secretValuesOf(context.accounts.map((a) => a.loginPath)))) console.log(line);
  const resolved = resolveAccounts(context);
  say(`contexte reçu (${resolved.roles.length} compte(s), ${context.detailedSteps.length} étape(s) détaillée(s))`);

  // 3. started
  const started = await postEvent(config, {
    type: "started",
    runId: inputs.runId,
    projectId: inputs.projectId,
    ticketKey: inputs.ticketKey,
    headSha: inputs.headSha,
    model: MODEL,
    effort: EFFORT,
  }).catch(() => null);
  if (started?.status === 409) {
    say("run déjà terminé côté feedback-app (annulé ?) : arrêt");
    return 0;
  }
  if (!started?.delivered) say(`événement started non remis (HTTP ${started?.status ?? "réseau"}) : on continue`);

  const reservations: string[] = [];
  if (context.headSha && !context.headSha.startsWith(inputs.headSha) && !inputs.headSha.startsWith(context.headSha)) {
    reservations.push("Le résumé du ticket a été généré sur une autre version de la PR que celle demandée.");
  }
  // Fusionnées à tout verdict, y compris celui de l'outil verdict (serveur MCP).
  writeRunnerReservations(runDir, reservations);

  // 4. Agent
  writeMcpConfig(p.mcpConfig, config, inputs, runDir, startedAt);
  const prompt = buildPrompt({
    ticketTitle: context.ticketTitle,
    ticketType: context.ticketType,
    brief: context.brief,
    detailedSteps: context.detailedSteps,
    roles: resolved.roles,
    startRole: context.startRole ? resolved.start : null,
    fixtures: context.fixtures.map((f) => f.name),
    maxTurns: MAX_TURNS,
    forced: inputs.forced,
  });
  const base = { model: MODEL, effort: EFFORT, mcpConfig: p.mcpConfig, allowedTools: `${TOOL_PREFIX}*` };
  const deadline = startedAt + AGENT_DEADLINE_MS;

  say(`agent lancé (${MODEL}, effort ${EFFORT}, ${MAX_TURNS} tours max)`);
  const first = await runClaude({
    args: claudeArgs({ ...base, prompt, maxTurns: MAX_TURNS }),
    env: cEnv,
    cwd: p.work,
    streamFile: p.streamMain,
    stderrFile: p.stderr,
    deadlineMs: deadline - Date.now(),
  });
  say(first.init ? `connexion : ${first.init}` : "connexion : pas d'événement init (MCP ou CLI en échec ?)");
  say(describe("agent terminé", first));
  const afterFirst = await settle(config, runDir, inputs, first);
  if (afterFirst !== null) return afterFirst;

  if (first.timedOut) {
    await send("inconclusive", "Le test a dépassé le temps imparti avant que l'agent ne rende son verdict.", "temps dépassé");
    say("verdict de repli envoyé (temps dépassé)");
    return 0;
  }

  // 5. Conclusion forcée : reprise de la même session, outil verdict seul.
  const remaining = deadline + CONCLUSION_DEADLINE_MS - Date.now();
  if (first.sessionId && remaining >= CONCLUSION_MIN_MS) {
    say("pas de verdict : reprise pour conclusion forcée");
    const again = await runClaude({
      args: claudeArgs({ ...base, prompt: CONCLUSION_PROMPT, maxTurns: CONCLUSION_MAX_TURNS, resume: first.sessionId }),
      env: cEnv,
      cwd: p.work,
      streamFile: p.streamConclusion,
      stderrFile: p.stderr,
      deadlineMs: Math.min(CONCLUSION_DEADLINE_MS, remaining),
    });
    say(describe("conclusion terminée", again));
    const afterSecond = await settle(config, runDir, inputs, again);
    if (afterSecond !== null) return afterSecond;
  }

  const maxTurns = first.resultSubtype === "error_max_turns";
  const reason = maxTurns ? "limite de tours" : first.timedOut ? "temps dépassé" : "agent arrêté sans verdict";
  await send(
    "inconclusive",
    maxTurns
      ? `L'agent a atteint la limite de ${MAX_TURNS} tours sans rendre de verdict.`
      : "L'agent s'est arrêté sans rendre de verdict.",
    reason,
  );
  say(`verdict de repli envoyé (${reason})`);
  return 0;
}

/**
 * Après un passage de `claude` : verdict remis → fin ; verdict en attente →
 * renvoi ; quota → waiting_quota. `null` = rien de final, continuer.
 */
async function settle(config: FeedbackAppConfig, runDir: string, inputs: RunInputs, run: ClaudeRun): Promise<number | null> {
  const flushed = await flushPending(config, runDir);
  if (flushed === "pending") {
    say("verdict rendu mais non remis à feedback-app");
    return 1;
  }
  if (readTerminal(runDir)) {
    say("verdict remis");
    return 0;
  }
  if (run.quota) {
    const res = await deliver(config, runDir, {
      type: "waiting_quota",
      runId: inputs.runId,
      resetsAt: run.quota.resetsAt,
      reason: run.quota.parsed ? "quota de l'abonnement atteint" : "quota de l'abonnement atteint (heure de reprise estimée)",
    });
    say(`quota d'abonnement atteint, reprise ${run.quota.resetsAt}${run.quota.parsed ? "" : " (estimée)"} : waiting_quota ${res === "sent" ? "remis" : "NON remis"}`);
    return 0;
  }
  return null;
}

/** Entrées invalides mais run_id utilisable : le run ne doit pas rester « en file ». */
async function rejectInvalidInputs(config: FeedbackAppConfig, why: string): Promise<void> {
  const runId = readRunId(process.env);
  if (!runId) return;
  const runDir = runDirFor(process.env, runId);
  ensureRunDir(runDir);
  await deliver(config, runDir, buildVerdictEvent({
    runId,
    status: "inconclusive",
    summary: "Le test n'a pas pu démarrer : paramètres de lancement invalides.",
    reservations: [],
    reason: `entrées invalides (${why})`,
    actions: [],
    captures: [],
    durationMs: 0,
  }));
}

function describe(label: string, r: ClaudeRun): string {
  return `${label} (code ${r.exitCode ?? "?"}, ${r.resultSubtype ?? "sans résultat"}, ${r.numTurns ?? "?"} tours${r.timedOut ? ", échéance atteinte" : ""})`;
}

function writeMcpConfig(file: string, config: FeedbackAppConfig, inputs: RunInputs, runDir: string, startedAt: number): void {
  const server = join(import.meta.dirname, "mcp-server.ts");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: ["--disable-warning=ExperimentalWarning", server],
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
            FEEDBACK_APP_URL: config.baseUrl,
            AUTO_TEST_WEBHOOK_SECRET: config.secret,
            PROJECT_ID: inputs.projectId,
            TICKET_KEY: inputs.ticketKey,
            RUN_ID: inputs.runId,
            RUN_DIR: runDir,
            RUN_STARTED_AT: String(startedAt),
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Jamais le message brut : il pourrait citer une URL de connexion.
    say(`erreur inattendue (${err instanceof Error ? err.name : "inconnue"})`);
    process.exit(1);
  });
