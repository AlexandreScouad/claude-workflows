import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../src/prompt.ts";
import { parseContext, usableRoles } from "../src/context.ts";

const LOGIN = "/fr/sign-in?email=collab%40acme.fr&password=TresSecret42";

const payload = {
  success: true,
  data: {
    previewUrl: "https://cockpit-git-fix.vercel.app",
    ticketTitle: "Appareil d'occasion par défaut",
    ticketType: "bug",
    headSha: "abc1234",
    brief: { problem: "Le genre est Occasion", cause: null, fix: "Défaut à Neuf", quickTest: "Lancer un onboarding et vérifier « Neuf »" },
    detailedSteps: ["Aller dans Onboarding", "Commander un iPhone 13"],
    accounts: [
      { role: "admin", loginPath: "/auto-login?token=ADMINTOKEN123" },
      { role: "client_collaborateur", loginPath: LOGIN },
      { role: "sans_chemin", loginPath: null },
    ],
    fixtures: [],
  },
};

function prompt(forced = false) {
  const ctx = parseContext(payload);
  assert.ok(ctx);
  return buildPrompt({ ...ctx, roles: usableRoles(ctx.accounts), fixtures: [], maxTurns: 80, forced });
}

test("le prompt ne contient jamais de chemin de connexion ni d'identifiant", () => {
  const p = prompt();
  for (const secret of [LOGIN, "TresSecret42", "collab%40acme.fr", "collab@acme.fr", "ADMINTOKEN123", "auto-login", "sign-in"]) {
    assert.ok(!p.includes(secret), `fuite : ${secret}`);
  }
});

test("rôles utilisables seulement (chemin présent)", () => {
  const p = prompt();
  assert.match(p, /Comptes disponibles \(outil se_connecter\) : admin, client_collaborateur\n/);
  assert.ok(!p.includes("sans_chemin"));
});

test("règles de recette et marqueur des données créées", () => {
  const p = prompt();
  assert.ok(p.includes("« [TEST AUTO] »"));
  assert.ok(p.includes("autotest+<slug>@example.com"));
  assert.match(p, /Ne supprime jamais rien/);
  assert.match(p, /Aucune action réellement sortante/);
  assert.match(p, /n'as pas créée toi-même/);
});

test("définitions des verdicts, doute → non concluant, budget et périmètre", () => {
  const p = prompt();
  assert.match(p, /Un ko exige une preuve/);
  assert.match(p, /Au moindre doute entre ko et non_concluant, choisis non_concluant/);
  assert.match(p, /Budget : 80 tours au maximum/);
  assert.match(p, /Vérifie d'abord le cas principal du test express/);
});

test("test express et plan détaillé inclus", () => {
  const p = prompt();
  assert.ok(p.includes("Lancer un onboarding et vérifier « Neuf »"));
  assert.ok(p.includes("1. Aller dans Onboarding\n2. Commander un iPhone 13"));
});

test("lancement forcé signalé", () => {
  assert.ok(!prompt(false).includes("Lancement forcé"));
  assert.ok(prompt(true).includes("Lancement forcé"));
});
