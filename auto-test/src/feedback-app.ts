// Client HTTP vers feedback-app : contexte (Bearer), captures (Bearer),
// événements du webhook (corps signé HMAC). Aucun corps de réponse n'est
// loggé : le contexte contient des identifiants.

import { parseContext, type AutoTestContext } from "./context.ts";
import { SIGNATURE_HEADER, signBody } from "./signature.ts";

export type FeedbackAppConfig = { baseUrl: string; secret: string };

export type AutoTestEvent =
  | { type: "started"; runId: string; projectId: string; ticketKey: string; headSha: string; model: string; effort: string }
  | { type: "waiting_quota"; runId: string; resetsAt: string; reason?: string }
  | {
      type: "verdict";
      runId: string;
      status: "ok" | "ko" | "inconclusive";
      summary: string;
      reservations: string[];
      log: Record<string, unknown>[];
      captures: { url: string; label: string }[];
      turns: number;
      durationMs: number;
      reason?: string;
    }
  | { type: "cancelled"; runId: string; reason: string };

const base = (c: FeedbackAppConfig) => c.baseUrl.replace(/\/+$/, "");
const bearer = (c: FeedbackAppConfig) => `Bearer ${c.secret.trim()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch avec 3 essais sur erreur réseau ou 5xx (502/503/504 de Vercel). */
async function fetchRetry(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500 || i === 2) return res;
    } catch (err) {
      lastErr = err;
      if (i === 2) throw err;
    }
    await sleep(2000 * (i + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch échoué");
}

export type ContextResult =
  | { ok: true; context: AutoTestContext }
  | { ok: false; status: number; code: string | null; error: string | null };

export async function fetchContext(c: FeedbackAppConfig, projectId: string, ticketKey: string): Promise<ContextResult> {
  const url = `${base(c)}/api/projects/${encodeURIComponent(projectId)}/auto-test/context?ticketKey=${encodeURIComponent(ticketKey)}`;
  // Le brief peut être généré à la volée côté feedback-app : délai large.
  const res = await fetchRetry(url, { headers: { authorization: bearer(c) }, cache: "no-store" }, 120_000);
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const context = parseContext(json);
    if (context) return { ok: true, context };
    return { ok: false, status: res.status, code: "invalid_payload", error: "Contexte illisible" };
  }
  const body = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  return {
    ok: false,
    status: res.status,
    code: typeof body.code === "string" ? body.code : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

export type PostResult = { status: number; delivered: boolean };

/**
 * POST signé sur le webhook. `delivered` = accepté (2xx) ou refusé parce que
 * le run est déjà dans un état final (409 : annulé par un nouveau commit,
 * ou événement rejoué) — dans les deux cas, rien à retenter.
 */
export async function postEvent(c: FeedbackAppConfig, event: AutoTestEvent): Promise<PostResult> {
  const body = JSON.stringify(event);
  const res = await fetchRetry(`${base(c)}/api/webhooks/auto-test`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(body, c.secret) },
    body,
  });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, delivered: res.ok || res.status === 409 };
}

export async function uploadCapture(
  c: FeedbackAppConfig,
  projectId: string,
  input: { runId: string; data: Buffer; contentType: "image/png" | "image/jpeg" | "image/webp"; label: string },
): Promise<{ url: string; label: string } | null> {
  const res = await fetchRetry(`${base(c)}/api/projects/${encodeURIComponent(projectId)}/auto-test/upload`, {
    method: "POST",
    headers: { authorization: bearer(c), "content-type": "application/json" },
    body: JSON.stringify({ runId: input.runId, dataBase64: input.data.toString("base64"), contentType: input.contentType, label: input.label }),
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    return null;
  }
  const json: unknown = await res.json().catch(() => null);
  const data = typeof json === "object" && json !== null ? (json as { data?: { url?: unknown; label?: unknown } }).data : undefined;
  return typeof data?.url === "string" ? { url: data.url, label: typeof data.label === "string" ? data.label : input.label } : null;
}
