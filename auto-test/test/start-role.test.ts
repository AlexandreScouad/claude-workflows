import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../src/prompt.ts";
import { parseContext, resolveAccounts, type AutoTestContext } from "../src/context.ts";
import { secretValuesOf } from "../src/sanitize.ts";

const ADMIN_LOGIN = "/fr/sign-in?email=admin%40acme.fr&password=AdminSecret1";
const COLLAB = "/fr/sign-in?email=collab%40acme.fr&password=CollabSecret2";
const MANAGER = "/fr/sign-in?email=manager%40acme.fr&password=ManagerSecret3";

function ctx(data: Record<string, unknown>): AutoTestContext {
  const c = parseContext({
    success: true,
    data: { previewUrl: "https://cockpit-git-fix.vercel.app", ticketTitle: "T", brief: {}, fixtures: [], ...data },
  });
  assert.ok(c);
  return c;
}

function promptOf(c: AutoTestContext): string {
  const r = resolveAccounts(c);
  return buildPrompt({ ...c, roles: r.roles, startRole: c.startRole ? r.start : null, fixtures: [], maxTurns: 80, forced: false });
}

// Forme servie par feedback-app #551 : départ en premier sous l'alias `admin`.
const unified = {
  startRole: "Collaborateur",
  accounts: [
    { role: "admin", loginPath: COLLAB },
    { role: "Admin", loginPath: ADMIN_LOGIN },
    { role: "Collaborateur", loginPath: COLLAB },
    { role: "Manager", loginPath: MANAGER },
  ],
};

test("startRole présent : connexion de départ sur ce compte", () => {
  const r = resolveAccounts(ctx(unified));
  assert.equal(r.start, "Collaborateur");
  assert.equal(r.startPath, COLLAB);
});

test("startRole présent : alias `admin` retiré, rôles sans doublon", () => {
  const r = resolveAccounts(ctx(unified));
  assert.deepEqual(r.roles, ["Admin", "Collaborateur", "Manager"]);
  assert.ok(!("admin" in r.byRole));
  const p = promptOf(ctx(unified));
  assert.match(p, /Connecté en : Collaborateur\n/);
  assert.match(p, /te connecte avec le compte « Collaborateur »/);
  assert.match(p, /Comptes disponibles \(outil se_connecter\) : Admin, Collaborateur, Manager\n/);
  for (const secret of [ADMIN_LOGIN, COLLAB, MANAGER, "AdminSecret1", "CollabSecret2", "ManagerSecret3"]) {
    assert.ok(!p.includes(secret), `fuite : ${secret}`);
  }
});

test("startRole présent : un vrai rôle `admin` distinct est conservé", () => {
  const r = resolveAccounts(
    ctx({
      startRole: "Collaborateur",
      accounts: [
        { role: "admin", loginPath: COLLAB },
        { role: "Collaborateur", loginPath: COLLAB },
        { role: "admin", loginPath: ADMIN_LOGIN },
      ],
    }),
  );
  assert.deepEqual(r.roles, ["Collaborateur", "admin"]);
  assert.equal(r.byRole.admin, ADMIN_LOGIN);
  assert.equal(r.startPath, COLLAB);
});

test("startRole vaut `admin` (vrai rôle) : départ et rôle conservés", () => {
  const r = resolveAccounts(
    ctx({ startRole: "admin", accounts: [{ role: "admin", loginPath: ADMIN_LOGIN }, { role: "admin", loginPath: ADMIN_LOGIN }, { role: "Manager", loginPath: MANAGER }] }),
  );
  assert.equal(r.start, "admin");
  assert.equal(r.startPath, ADMIN_LOGIN);
  assert.deepEqual(r.roles, ["admin", "Manager"]);
});

test("startRole inconnu ou sans chemin : repli sur `admin`, puis premier compte", () => {
  const withAdmin = resolveAccounts(ctx({ startRole: "Fantome", accounts: [{ role: "Manager", loginPath: MANAGER }, { role: "admin", loginPath: ADMIN_LOGIN }] }));
  assert.equal(withAdmin.start, "admin");
  assert.equal(withAdmin.startPath, ADMIN_LOGIN);
  const noAdmin = resolveAccounts(ctx({ startRole: "Fantome", accounts: [{ role: "Manager", loginPath: MANAGER }, { role: "Collaborateur", loginPath: COLLAB }] }));
  assert.equal(noAdmin.start, "Manager");
  assert.equal(noAdmin.startPath, MANAGER);
});

test("startRole absent (ancien feedback-app) : comportement actuel", () => {
  const legacy = ctx({
    accounts: [
      { role: "admin", loginPath: "/auto-login?token=ADMINTOKEN123" },
      { role: "client_collaborateur", loginPath: COLLAB },
      { role: "sans_chemin", loginPath: null },
    ],
  });
  assert.equal(legacy.startRole, null);
  const r = resolveAccounts(legacy);
  assert.equal(r.start, "admin");
  assert.equal(r.startPath, "/auto-login?token=ADMINTOKEN123");
  assert.deepEqual(r.roles, ["admin", "client_collaborateur"]);
  const p = promptOf(legacy);
  assert.ok(!p.includes("Connecté en :"));
  assert.match(p, /te connecte avec le compte « admin »/);
  assert.match(p, /Comptes disponibles \(outil se_connecter\) : admin, client_collaborateur\n/);
});

test("aucun compte : ouverture de la racine", () => {
  const r = resolveAccounts(ctx({ accounts: [] }));
  assert.equal(r.start, null);
  assert.equal(r.startPath, null);
  assert.deepEqual(r.roles, []);
});

test("masquage : tous les comptes reçus, alias compris", () => {
  const c = ctx(unified);
  const secrets = secretValuesOf(c.accounts.map((a) => a.loginPath));
  for (const s of [ADMIN_LOGIN, COLLAB, MANAGER, "AdminSecret1", "CollabSecret2", "ManagerSecret3", "admin@acme.fr", "collab@acme.fr", "manager@acme.fr"]) {
    assert.ok(secrets.includes(s), `non masqué : ${s}`);
  }
});
