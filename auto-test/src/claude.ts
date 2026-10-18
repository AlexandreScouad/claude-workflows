// Lancement de Claude Code headless (`claude -p`) sur l'abonnement.
//
// - Auth : CLAUDE_CODE_OAUTH_TOKEN seul — ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
//   sont retirées (elles passeraient avant l'abonnement). Pas de --bare (il
//   ignore le jeton OAuth).
// - Isolation : cwd et CLAUDE_CONFIG_DIR dans RUN_DIR (hors checkout : ni
//   CLAUDE.md, ni hooks, ni réglages du dépôt ou de l'utilisateur), outils
//   natifs coupés (--tools ""), seuls les outils MCP scouad-test autorisés.
// - Sortie : le stream JSON va dans un fichier JAMAIS affiché ni uploadé (le
//   dépôt est public). On n'en extrait que session_id, sous-type du résultat,
//   nombre de tours et un éventuel message de quota.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { detectQuota, type QuotaHit } from "./quota.ts";

// Binaire épinglé par le lockfile (@anthropic-ai/claude-code). Surcharge
// réservée aux tests locaux du runner (faux `claude`).
const CLAUDE_BIN = process.env.AUTO_TEST_CLAUDE_BIN || join(import.meta.dirname, "..", "node_modules", ".bin", "claude");

/** Env de `claude` : sans clés API ni secret du webhook (réservé au serveur MCP). */
export function claudeEnv(base: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AUTO_TEST_WEBHOOK_SECRET", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    delete env[k];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Préflight : `claude auth status --json` → méthode d'auth (seule info loggée). */
export async function authMethod(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["auth", "status", "--json"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve("erreur"));
    child.on("close", () => {
      try {
        const json = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
        resolve(json.loggedIn ? String(json.authMethod ?? "inconnue") : "non connecté");
      } catch {
        resolve("illisible");
      }
    });
  });
}

export type ClaudeRun = {
  exitCode: number | null;
  sessionId: string | null;
  resultSubtype: string | null;
  numTurns: number | null;
  quota: QuotaHit | null;
  timedOut: boolean;
};

export type ClaudeArgs = {
  prompt: string;
  model: string;
  effort: string;
  maxTurns: number;
  mcpConfig: string;
  allowedTools: string;
  resume?: string;
};

export function claudeArgs(a: ClaudeArgs): string[] {
  return [
    "-p", a.prompt,
    "--model", a.model,
    "--effort", a.effort,
    "--max-turns", String(a.maxTurns),
    ...(a.resume ? ["--resume", a.resume] : []),
    "--strict-mcp-config", "--mcp-config", a.mcpConfig,
    "--tools", "",
    "--allowedTools", a.allowedTools,
    "--permission-mode", "dontAsk",
    "--output-format", "stream-json", "--verbose",
  ];
}

/** Événements où un message de quota peut apparaître (pas les résultats d'outils : texte des pages testées). */
const QUOTA_EVENT_TYPES = new Set(["result", "assistant", "system", "error"]);

export function runClaude(opts: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; streamFile: string; stderrFile: string; deadlineMs: number }): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const stream = createWriteStream(opts.streamFile, { flags: "a", mode: 0o600 });
    const stderr = createWriteStream(opts.stderrFile, { flags: "a", mode: 0o600 });
    const run: ClaudeRun = { exitCode: null, sessionId: null, resultSubtype: null, numTurns: null, quota: null, timedOut: false };
    let buf = "";
    let errTail = "";

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: Record<string, unknown> | null = null;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        ev = null;
      }
      if (ev && typeof ev.session_id === "string" && !run.sessionId) run.sessionId = ev.session_id;
      if (ev?.type === "result") {
        run.resultSubtype = typeof ev.subtype === "string" ? ev.subtype : null;
        run.numTurns = typeof ev.num_turns === "number" ? ev.num_turns : null;
      }
      if (!run.quota && (!ev || QUOTA_EVENT_TYPES.has(String(ev.type)))) run.quota = detectQuota(line);
    };

    child.stdout.on("data", (d: Buffer) => {
      stream.write(d);
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr.write(d);
      errTail = (errTail + d.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      run.timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, Math.max(1000, opts.deadlineMs));

    child.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      run.quota ??= detectQuota(errTail);
      run.exitCode = code;
      stream.end();
      stderr.end();
      resolve(run);
    });
  });
}
