// Construction et envoi du verdict. Utilisé par l'outil `verdict` du serveur
// MCP (cas normal) et par le runner (replis : limite de tours, temps dépassé,
// erreur) — dans les deux cas à partir de l'état sur disque.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ActionEntry } from "./run-dir.ts";
import { finalCapturePath, listCaptures, markTerminal, readActions, readTerminal, runPaths } from "./run-dir.ts";
import { postEvent, uploadCapture, type AutoTestEvent, type FeedbackAppConfig } from "./feedback-app.ts";

export type AgentStatut = "ok" | "ko" | "non_concluant";
export type VerdictStatus = "ok" | "ko" | "inconclusive";

/** Statut de l'outil (français, vu par le modèle) → statut du webhook. */
export function toWebhookStatus(statut: string): VerdictStatus {
  const s = statut.trim().toLowerCase();
  if (s === "ok") return "ok";
  if (s === "ko") return "ko";
  return "inconclusive";
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export type VerdictInput = {
  runId: string;
  status: VerdictStatus;
  summary: string;
  reservations: readonly string[];
  reason?: string;
  actions: readonly ActionEntry[];
  captures: { url: string; label: string }[];
  durationMs: number;
};

/** Événement `verdict` conforme au webhook (summary non vide, listes typées). */
export function buildVerdictEvent(v: VerdictInput): Extract<AutoTestEvent, { type: "verdict" }> {
  const summary = clip(v.summary.trim(), 2000) || "Pas de résumé fourni par l'agent.";
  return {
    type: "verdict",
    runId: v.runId,
    status: v.status,
    summary,
    reservations: v.reservations.map((r) => clip(r.trim(), 500)).filter(Boolean).slice(0, 20),
    log: v.actions.slice(0, 300).map((a) => ({ ...a })),
    captures: v.captures,
    // Tours ≈ appels d'outils (le serveur MCP ne voit pas les tours de `claude`).
    turns: v.actions.length,
    durationMs: Math.max(0, Math.round(v.durationMs)),
    ...(v.reason ? { reason: v.reason } : {}),
  };
}

export type SendContext = {
  config: FeedbackAppConfig;
  runDir: string;
  projectId: string;
  runId: string;
  startedAt: number;
};

/**
 * Uploade les captures (agent puis écran final), poste le verdict signé et
 * pose le marqueur final. Sans effet si un événement final est déjà remis.
 * Si l'envoi échoue, le verdict est gardé dans `pending-event.json` (le runner
 * le renvoie).
 */
export async function sendVerdict(
  ctx: SendContext,
  v: { status: VerdictStatus; summary: string; reservations: readonly string[]; reason?: string },
): Promise<"sent" | "already" | "pending"> {
  if (readTerminal(ctx.runDir)) return "already";
  // Un verdict déjà rendu mais pas remis prime sur tout nouveau (ex. un repli
  // « limite de tours » ne doit pas écraser le vrai verdict de l'agent).
  if (existsSync(runPaths(ctx.runDir).pending)) {
    return (await flushPending(ctx.config, ctx.runDir)) === "sent" ? "sent" : "pending";
  }
  const files = listCaptures(ctx.runDir).map((file, i) => ({ file, label: `Capture ${i + 1}` }));
  const final = finalCapturePath(ctx.runDir);
  if (existsSync(final)) files.push({ file: final, label: "Écran final" });
  const captures: { url: string; label: string }[] = [];
  for (const f of files) {
    try {
      const up = await uploadCapture(ctx.config, ctx.projectId, { runId: ctx.runId, data: readFileSync(f.file), contentType: "image/png", label: f.label });
      if (up) captures.push(up);
    } catch {
      /* capture perdue : le verdict part quand même */
    }
  }
  const event = buildVerdictEvent({
    runId: ctx.runId,
    ...v,
    actions: readActions(ctx.runDir),
    captures,
    durationMs: Date.now() - ctx.startedAt,
  });
  return deliver(ctx.config, ctx.runDir, event);
}

/** Remet un événement final ; le garde sur disque si feedback-app ne répond pas. */
export async function deliver(config: FeedbackAppConfig, runDir: string, event: AutoTestEvent): Promise<"sent" | "pending"> {
  const p = runPaths(runDir);
  try {
    const res = await postEvent(config, event);
    if (res.delivered) {
      markTerminal(runDir, {
        type: event.type === "waiting_quota" ? "waiting_quota" : "verdict",
        ...(event.type === "verdict" ? { status: event.status } : {}),
        httpStatus: res.status,
      });
      rmSync(p.pending, { force: true });
      return "sent";
    }
  } catch {
    /* réseau : gardé en attente */
  }
  writeFileSync(p.pending, JSON.stringify(event), { mode: 0o600 });
  return "pending";
}

/** Renvoie un événement final resté en attente. */
export async function flushPending(config: FeedbackAppConfig, runDir: string): Promise<"none" | "sent" | "pending"> {
  const p = runPaths(runDir);
  if (readTerminal(runDir) || !existsSync(p.pending)) return "none";
  const event = JSON.parse(readFileSync(p.pending, "utf8")) as AutoTestEvent;
  return deliver(config, runDir, event);
}
