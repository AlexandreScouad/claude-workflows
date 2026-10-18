import { test } from "node:test";
import assert from "node:assert/strict";
import { createSanitizer, maskCommands, redactUrl, secretValuesOf } from "../src/sanitize.ts";

const LOGIN = "/fr/sign-in?email=client%2Badmin%40acme.fr&password=S3cr3t%21Pass";

test("redactUrl retire query et hash", () => {
  assert.equal(redactUrl("https://preview.example.com/fr/sign-in?email=a&password=b#x"), "https://preview.example.com/fr/sign-in");
});

test("valeurs à masquer : chemin complet + valeurs brutes et décodées", () => {
  const values = secretValuesOf([LOGIN, null]);
  assert.ok(values.includes(LOGIN));
  assert.ok(values.includes("S3cr3t%21Pass"));
  assert.ok(values.includes("S3cr3t!Pass"));
  assert.ok(values.includes("client+admin@acme.fr"));
});

test("l'expurgeur efface une erreur Playwright qui cite l'URL de connexion", () => {
  const clean = createSanitizer(secretValuesOf([LOGIN]));
  const err = `page.goto: Timeout 45000ms exceeded.\n  navigating to "https://preview.example.com${LOGIN}", waiting until "domcontentloaded"`;
  const out = clean(err);
  assert.ok(!out.includes("S3cr3t"));
  assert.ok(!out.includes("acme.fr"));
  assert.ok(out.includes("navigating to"));
});

test("l'expurgeur masque les paramètres sensibles même inconnus", () => {
  const clean = createSanitizer([]);
  const out = clean("https://x.test/login?password=autre&email=b@c.d et aussi /x?token=abc123");
  assert.ok(!out.includes("autre"));
  assert.ok(!out.includes("abc123"));
});

test("::add-mask:: une ligne par valeur, sans valeur courte", () => {
  const lines = maskCommands(["abc", "assez-long"]);
  assert.deepEqual(lines, ["::add-mask::assez-long"]);
});

test("les paramètres non identifiants (redirect, remember) ne sont pas masqués", () => {
  const values = secretValuesOf(["/fr/sign-in?redirect=%2Ffr%2Fdashboard&remember=true&email=x%40acme.fr&password=Abcd1234"]);
  assert.ok(!values.includes("/fr/dashboard"));
  assert.ok(!values.includes("true"));
  assert.ok(values.includes("Abcd1234"));
  assert.ok(values.includes("x@acme.fr"));
  const clean = createSanitizer(values);
  assert.equal(clean("Retour au /fr/dashboard"), "Retour au /fr/dashboard");
});
