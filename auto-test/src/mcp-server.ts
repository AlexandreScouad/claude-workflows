// Serveur MCP stdio « scouad-test » : les seuls outils de l'agent testeur.
//
// Lancé par `claude` (mcp.json écrit par le runner, hors checkout). Il
// récupère lui-même le contexte du test (comptes par rôle compris) auprès de
// feedback-app : les identifiants ne passent jamais par le modèle. Sa sortie
// standard est le canal MCP : rien d'autre ne doit y être écrit.
//
// Env : FEEDBACK_APP_URL, AUTO_TEST_WEBHOOK_SECRET, PROJECT_ID, TICKET_KEY,
// RUN_ID, RUN_DIR, RUN_STARTED_AT (ms epoch).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserSession, type ToolResult } from "./browser.ts";
import { resolveAccounts } from "./context.ts";
import { fetchContext, type FeedbackAppConfig } from "./feedback-app.ts";
import { appendAction, ensureRunDir, finalCapturePath, listCaptures, readTerminal, runPaths } from "./run-dir.ts";
import { createSanitizer, secretValuesOf } from "./sanitize.ts";
import { sendVerdict, toWebhookStatus } from "./verdict.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable manquante : ${name}`);
  return v;
}

const config: FeedbackAppConfig = { baseUrl: env("FEEDBACK_APP_URL"), secret: env("AUTO_TEST_WEBHOOK_SECRET") };
const PROJECT_ID = env("PROJECT_ID");
const TICKET_KEY = env("TICKET_KEY");
const RUN_ID = env("RUN_ID");
const RUN_DIR = env("RUN_DIR");
const STARTED_AT = Number(process.env.RUN_STARTED_AT) || Date.now();
const paths = runPaths(RUN_DIR);
ensureRunDir(RUN_DIR);

let sanitize = createSanitizer([]);
let session: BrowserSession | null = null;
let sessionPromise: Promise<BrowserSession> | null = null;
/** Verdict déjà rendu (dans ce process ou un précédent : reprise --resume). */
let finished = Boolean(readTerminal(RUN_DIR)) || existsSync(paths.pending);

async function downloadFixtures(fixtures: { name: string; url: string }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of fixtures) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const file = join(paths.fixtures, f.name);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      out[f.name] = file;
    } catch {
      /* fichier indisponible : simplement absent de la liste */
    }
  }
  return out;
}

async function getSession(): Promise<BrowserSession> {
  if (session) return session;
  sessionPromise ??= (async () => {
    const res = await fetchContext(config, PROJECT_ID, TICKET_KEY);
    if (!res.ok) throw new Error(`Contexte du test indisponible (HTTP ${res.status}${res.code ? `, ${res.code}` : ""}).`);
    const { byRole, startPath } = resolveAccounts(res.context);
    // Masquage : TOUS les chemins reçus, alias compris.
    sanitize = createSanitizer(secretValuesOf(res.context.accounts.map((a) => a.loginPath)));
    const s = new BrowserSession({
      previewUrl: res.context.previewUrl,
      accounts: byRole,
      startPath,
      fixtures: await downloadFixtures(res.context.fixtures),
      capturesDir: paths.captures,
      finalCapture: finalCapturePath(RUN_DIR),
      existingCaptures: listCaptures(RUN_DIR).length,
    });
    session = s;
    return s;
  })();
  try {
    return await sessionPromise;
  } catch (err) {
    sessionPromise = null;
    throw err;
  }
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function clean(results: ToolResult[]): McpContent[] {
  return results.map((r) => (r.type === "text" ? { type: "text", text: sanitize(r.text) } : r));
}

/** Arguments journalisés (expurgés, textes tronqués). */
function logArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" ? sanitize(v).slice(0, 200) : v;
  return out;
}

async function call(name: string, input: Record<string, unknown>) {
  const at = new Date().toISOString();
  if (finished) return { content: [{ type: "text" as const, text: "Le test est terminé : verdict déjà enregistré." }] };
  try {
    const s = await getSession();
    const content = clean(await s.run(name, input));
    appendAction(RUN_DIR, { at, outil: name, args: logArgs(input), ok: true });
    return { content };
  } catch (err) {
    const message = sanitize(err instanceof Error ? err.message : String(err)).slice(0, 300);
    appendAction(RUN_DIR, { at, outil: name, args: logArgs(input), ok: false, note: message });
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

const server = new McpServer({ name: "scouad-test", version: "1.0.0" });
const ref = z.number().int().describe("Numéro [ref] obtenu par lire");

server.registerTool("ouvrir", { description: "Ouvre un chemin de la preview (ex. /devis). Seul le domaine de la preview est autorisé.", inputSchema: { chemin: z.string() } }, (a) => call("ouvrir", a));
server.registerTool("lire", { description: "Texte visible de la page (ou de la modale ouverte et de ses listes déroulantes) + éléments interactifs numérotés [ref]." }, () => call("lire", {}));
server.registerTool("cliquer", { description: "Clique sur l'élément [ref] obtenu par lire.", inputSchema: { ref } }, (a) => call("cliquer", a));
server.registerTool("cliquer_texte", { description: "Clique sur l'élément visible au premier plan dont le texte contient ce libellé (cartes, tuiles, options sans [ref]).", inputSchema: { texte: z.string() } }, (a) => call("cliquer_texte", a));
server.registerTool("taper", { description: "Remplace le contenu du champ [ref] par le texte.", inputSchema: { ref, texte: z.string() } }, (a) => call("taper", a));
server.registerTool("choisir", { description: "Choisit une option (libellé ou valeur) dans la liste déroulante native [ref].", inputSchema: { ref, option: z.string() } }, (a) => call("choisir", a));
server.registerTool("deposer", { description: "Dépose un fichier d'exemple (nom exact parmi la liste fournie) dans le champ fichier [ref].", inputSchema: { ref, fichier: z.string() } }, (a) => call("deposer", a));
server.registerTool("se_connecter", { description: "Se déconnecte puis se reconnecte avec le compte du rôle demandé (rôles fournis dans la consigne).", inputSchema: { role: z.string() } }, (a) => call("se_connecter", a));
server.registerTool("capture", { description: "Capture d'écran de la page visible (4 max). Lis la page d'abord ; capture pour vérifier un rendu visuel." }, () => call("capture", {}));

server.registerTool(
  "verdict",
  {
    description:
      "Termine le test. ok = cas principal déroulé et résultat attendu observé ; ko = cas principal déroulé et résultat attendu non obtenu, preuve à l'appui ; non_concluant = impossible de conclure pour une cause extérieure au correctif (au doute, non_concluant).",
    inputSchema: {
      statut: z.enum(["ok", "ko", "non_concluant"]),
      resume: z.string().min(1).describe("Une à trois phrases, en français : ce qui a été vérifié et observé."),
      reserves: z.array(z.string()).optional().describe("Ce qui n'a pas été couvert ou vérifié (une entrée par point)."),
    },
  },
  async (a) => {
    if (finished) return { content: [{ type: "text" as const, text: "Verdict déjà enregistré. Le test est terminé." }] };
    finished = true;
    appendAction(RUN_DIR, { at: new Date().toISOString(), outil: "verdict", args: { statut: a.statut }, ok: true });
    await session?.close(true);
    session = null;
    await sendVerdict(
      { config, runDir: RUN_DIR, projectId: PROJECT_ID, runId: RUN_ID, startedAt: STARTED_AT },
      { status: toWebhookStatus(a.statut), summary: sanitize(a.resume), reservations: (a.reserves ?? []).map(sanitize) },
    );
    return { content: [{ type: "text" as const, text: "Verdict enregistré. Le test est terminé." }] };
  },
);

async function shutdown(): Promise<void> {
  await session?.close(false);
  process.exit(0);
}
process.stdin.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await server.connect(new StdioServerTransport());
