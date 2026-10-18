// Entrées du run. Sur Actions, lues dans l'événement workflow_dispatch
// ($GITHUB_EVENT_PATH) plutôt que dans l'`env:` du step : le bloc `env:` est
// affiché dans les logs publics, et un input interpolé dans `run:` serait une
// injection de script. En local : variables PROJECT_ID, TICKET_KEY, RUN_ID,
// HEAD_SHA, FORCED.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackAppConfig } from "./feedback-app.ts";

export type RunInputs = { projectId: string; ticketKey: string; runId: string; headSha: string; forced: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInputs(raw: Record<string, unknown>): RunInputs | string {
  const s = (k: string) => (typeof raw[k] === "string" ? String(raw[k]).trim() : typeof raw[k] === "boolean" ? String(raw[k]) : "");
  const projectId = s("project_id");
  const ticketKey = s("ticket_key");
  const runId = s("run_id");
  const headSha = s("head_sha");
  if (!UUID_RE.test(projectId)) return "project_id invalide";
  if (!UUID_RE.test(runId)) return "run_id invalide";
  if (!/^[\w.-]{1,80}$/.test(ticketKey)) return "ticket_key invalide";
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) return "head_sha invalide";
  return { projectId, ticketKey, runId, headSha, forced: s("forced") === "true" };
}

export function readInputs(env: NodeJS.ProcessEnv): RunInputs | string {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { inputs?: Record<string, unknown> };
      if (event.inputs) return parseInputs(event.inputs);
    } catch {
      return "événement GitHub illisible";
    }
  }
  return parseInputs({
    project_id: env.PROJECT_ID,
    ticket_key: env.TICKET_KEY,
    run_id: env.RUN_ID,
    head_sha: env.HEAD_SHA,
    forced: env.FORCED,
  });
}

export function feedbackAppConfig(env: NodeJS.ProcessEnv): FeedbackAppConfig | string {
  const baseUrl = env.FEEDBACK_APP_URL?.trim();
  const secret = env.AUTO_TEST_WEBHOOK_SECRET;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return "FEEDBACK_APP_URL manquante";
  if (!secret?.trim()) return "AUTO_TEST_WEBHOOK_SECRET manquant";
  return { baseUrl, secret };
}

/** RUN_DIR : sous $RUNNER_TEMP (hors checkout, effacé en fin de job). */
export function runDirFor(env: NodeJS.ProcessEnv, runId: string): string {
  return join(env.RUNNER_TEMP || tmpdir(), `scouad-auto-test-${runId}`);
}
