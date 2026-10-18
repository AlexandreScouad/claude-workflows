// État d'un run partagé sur disque entre le runner et le serveur MCP.
//
// Le serveur MCP est un process lancé par `claude` : la reprise `--resume`
// (conclusion forcée) en relance un NOUVEAU. Journal d'actions, captures et
// marqueur « événement final envoyé » vivent donc dans RUN_DIR, jamais en
// mémoire. RUN_DIR est sous $RUNNER_TEMP, hors du checkout, jamais uploadé.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function runPaths(runDir: string) {
  return {
    actions: join(runDir, "actions.jsonl"),
    captures: join(runDir, "captures"),
    fixtures: join(runDir, "fixtures"),
    /** Événement final (verdict / waiting_quota) remis à feedback-app. */
    terminal: join(runDir, "terminal.json"),
    /** Verdict construit mais pas remis (erreur réseau) : le runner le renvoie. */
    pending: join(runDir, "pending-event.json"),
    /** Réserves ajoutées par le runner (ex. version du brief), fusionnées au verdict. */
    reservations: join(runDir, "runner-reservations.json"),
    streamMain: join(runDir, "stream.jsonl"),
    streamConclusion: join(runDir, "stream-conclusion.jsonl"),
    stderr: join(runDir, "claude-stderr.log"),
    claudeConfig: join(runDir, "claude-config"),
    work: join(runDir, "work"),
    mcpConfig: join(runDir, "mcp.json"),
  };
}

export function ensureRunDir(runDir: string): void {
  const p = runPaths(runDir);
  for (const dir of [runDir, p.captures, p.fixtures, p.claudeConfig, p.work]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export type ActionEntry = { at: string; outil: string; args?: Record<string, unknown>; ok: boolean; note?: string };

export function appendAction(runDir: string, entry: ActionEntry): void {
  appendFileSync(runPaths(runDir).actions, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readActions(runDir: string): ActionEntry[] {
  const file = runPaths(runDir).actions;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ActionEntry];
      } catch {
        return [];
      }
    });
}

/** Captures demandées par l'agent, dans l'ordre (capture-1.png, capture-2.png…). */
export function listCaptures(runDir: string): string[] {
  const dir = runPaths(runDir).captures;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^capture-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((f) => join(dir, f));
}

export function finalCapturePath(runDir: string): string {
  return join(runPaths(runDir).captures, "final.png");
}

export type TerminalMarker = { type: "verdict" | "waiting_quota"; status?: string; httpStatus: number };

export function markTerminal(runDir: string, marker: TerminalMarker): void {
  writeFileSync(runPaths(runDir).terminal, JSON.stringify(marker), { mode: 0o600 });
}

export function readTerminal(runDir: string): TerminalMarker | null {
  const file = runPaths(runDir).terminal;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TerminalMarker;
  } catch {
    return null;
  }
}

export function writeRunnerReservations(runDir: string, reservations: readonly string[]): void {
  writeFileSync(runPaths(runDir).reservations, JSON.stringify(reservations), { mode: 0o600 });
}

export function readRunnerReservations(runDir: string): string[] {
  const file = runPaths(runDir).reservations;
  if (!existsSync(file)) return [];
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
