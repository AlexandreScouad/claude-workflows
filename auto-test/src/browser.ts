// Outils navigateur du testeur (portés du spike feedback-app #502) :
// Chromium headless via Playwright, lecture par calques (modale + listes
// Radix en portail), cliquables non sémantiques, clic par texte au premier
// plan, connexion par rôle, dépôt de fichiers d'exemple, captures plafonnées.
//
// Les chemins de connexion restent ici : le modèle ne voit que des URLs
// expurgées (origin + pathname) et des messages passés par l'expurgeur.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { MAX_CAPTURES } from "./config.ts";
import { redactUrl } from "./sanitize.ts";

export type ToolResult = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Helpers posés dans la page (en chaîne : pas de transformation de la
 * fonction par un bundler) : racine = modale ouverte la plus haute (sinon
 * body), calques = modale + listes déroulantes en portail, test « au premier
 * plan », recherche par texte.
 */
const PAGE_HELPERS = `
window.__sfRoot = () => {
  const dialogs = Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]'))
    .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(d).visibility !== 'hidden'; });
  return dialogs.length ? dialogs[dialogs.length - 1] : document.body;
};
window.__sfLayers = () => {
  const root = window.__sfRoot();
  if (root === document.body) return [root];
  const pops = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper], [data-radix-select-content], [role=listbox], [role=menu], [cmdk-list]'))
    .filter((p) => !root.contains(p) && !p.parentElement?.closest('[data-radix-popper-content-wrapper], [role=listbox], [role=menu]'))
    .filter((p) => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return [root, ...pops];
};
window.__sfOnTop = (e) => {
  const r = e.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
  if (r.bottom < 0 || r.top > innerHeight) return true;
  const hit = document.elementFromPoint(x, y);
  return !!hit && (hit === e || e.contains(hit) || hit.contains(e));
};
window.__sfFind = (needle) => {
  document.querySelectorAll('[data-sf-target]').forEach((e) => e.removeAttribute('data-sf-target'));
  const norm = (t) => (t || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const want = norm(needle);
  const all = window.__sfLayers().flatMap((l) => Array.from(l.querySelectorAll('*'))).filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && norm(e.innerText).includes(want) && window.__sfOnTop(e);
  });
  all.sort((a, b) => (norm(a.innerText) === want ? 0 : 1) - (norm(b.innerText) === want ? 0 : 1) || a.innerText.length - b.innerText.length);
  if (!all[0]) return false;
  all[0].setAttribute('data-sf-target', '1');
  return true;
};
window.__sfRead = () => {
  const root = window.__sfRoot();
  const layers = window.__sfLayers();
  document.querySelectorAll('[data-sf-ref]').forEach((e) => e.removeAttribute('data-sf-ref'));
  const sel = "a[href], button, input, textarea, select, label, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=option], [role=menuitem], [role=switch], [contenteditable=true], [onclick], [tabindex]:not([tabindex='-1'])";
  const found = new Set(layers.flatMap((l) => Array.from(l.querySelectorAll(sel))));
  layers.flatMap((l) => Array.from(l.querySelectorAll('div, li, span, img, svg, td, tr'))).forEach((e) => {
    if (getComputedStyle(e).cursor !== 'pointer') return;
    const p = e.parentElement;
    if (p && getComputedStyle(p).cursor === 'pointer') return;
    if (e.closest(sel)) return;
    found.add(e);
  });
  const items = [];
  let n = 0;
  Array.from(found).forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(e).visibility === 'hidden') return;
    if (!window.__sfOnTop(e)) return;
    n += 1;
    e.setAttribute('data-sf-ref', String(n));
    const isPwd = e.getAttribute('type') === 'password';
    const label = (e.getAttribute('aria-label') || e.placeholder || e.innerText || (isPwd ? '' : e.value) || e.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    const kind = e.tagName.toLowerCase() + (e.getAttribute('type') ? '[' + e.getAttribute('type') + ']' : '') + (e.matches(sel) ? '' : ' (cliquable)');
    items.push('[' + n + '] ' + kind + ' « ' + label + ' »');
  });
  const text = layers.map((l) => l.innerText).join('\\n\\n--- Liste déroulante ouverte ---\\n').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  const scope = root === document.body ? '' : '(Une fenêtre modale est ouverte : seul son contenu est listé.)\\n';
  return 'Titre : ' + document.title + '\\n' + scope + '\\n' + text + '\\n\\n--- Éléments interactifs ---\\n' + items.slice(0, 200).join('\\n');
};`;

export type SessionOptions = {
  previewUrl: string;
  /** rôle → chemin de connexion (avec identifiants). */
  accounts: Record<string, string>;
  /** Chemin de connexion du compte de départ (null : racine de la preview). */
  startPath: string | null;
  /** nom → chemin local des fichiers d'exemple. */
  fixtures: Record<string, string>;
  capturesDir: string;
  finalCapture: string;
  existingCaptures: number;
};

const text = (t: string): ToolResult[] => [{ type: "text", text: t }];

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly origin: string;
  private readonly opts: SessionOptions;
  private captures: number;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.origin = new URL(opts.previewUrl).origin;
    this.captures = opts.existingCaptures;
  }

  /** Ouvre Chromium et se connecte avec le compte de départ (auto-login) au premier appel. */
  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ viewport: { width: 1366, height: 860 }, locale: "fr-FR" });
    // Domaine limité à la preview : toute navigation principale ailleurs est
    // bloquée (les ressources tierces — API, CDN — restent chargées).
    await context.route("**/*", (route) => {
      const req = route.request();
      let blocked = false;
      try {
        const frame = req.frame();
        blocked = req.isNavigationRequest() && frame === frame.page().mainFrame() && new URL(req.url()).origin !== this.origin;
      } catch {
        blocked = false; // requête sans frame (service worker) : pas une navigation
      }
      return blocked ? route.abort("blockedbyclient") : route.continue();
    });
    this.page = await context.newPage();
    const start = this.opts.startPath ?? "/";
    await this.page.goto(this.origin + start, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle();
    return this.page;
  }

  private async settle(): Promise<void> {
    await this.page?.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  }

  private loc(ref: unknown) {
    if (!this.page) throw new Error("Page non ouverte");
    return this.page.locator(`[data-sf-ref="${Number(ref)}"]`).first();
  }

  /**
   * URL courante après une action. Une navigation hors preview est bloquée
   * (page d'erreur du navigateur) : on revient en arrière et on le dit.
   */
  private async where(): Promise<string> {
    const page = this.page;
    if (!page) return "URL : (aucune page)";
    let origin = "";
    try {
      origin = new URL(page.url()).origin;
    } catch {
      origin = "";
    }
    if (origin !== this.origin) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
      if (!page.url().startsWith(this.origin)) await page.goto(this.origin + "/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      await this.settle();
      return `Navigation hors du domaine de la preview bloquée. URL : ${this.url()}`;
    }
    return `URL : ${this.url()}`;
  }

  private url(): string {
    return this.page ? redactUrl(this.page.url()) : "(aucune page)";
  }

  async run(name: string, input: Record<string, unknown>): Promise<ToolResult[]> {
    const page = await this.ensurePage();
    switch (name) {
      case "ouvrir": {
        let target: URL;
        try {
          target = new URL(String(input.chemin ?? "/"), this.origin);
        } catch {
          return text("Chemin invalide.");
        }
        if (target.origin !== this.origin) return text("Refusé : domaine hors preview.");
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.settle();
        return text(`Ouvert : ${this.url()}`);
      }
      case "lire": {
        await page.evaluate(PAGE_HELPERS);
        const out = await page.evaluate("window.__sfRead()");
        return text(String(out));
      }
      case "cliquer":
        await this.loc(input.ref).click({ timeout: 8000 });
        await this.settle();
        return text(`Cliqué. ${await this.where()}`);
      case "cliquer_texte": {
        const needle = String(input.texte ?? "");
        await page.evaluate(PAGE_HELPERS);
        const found = await page.evaluate(`window.__sfFind(${JSON.stringify(needle)})`);
        if (!found) return text(`Aucun élément visible au premier plan ne contient « ${needle} ».`);
        await page.locator("[data-sf-target]").first().click({ timeout: 8000 });
        await this.settle();
        return text(`Cliqué « ${needle} ». ${await this.where()}`);
      }
      case "taper":
        await this.loc(input.ref).fill(String(input.texte ?? ""), { timeout: 8000 });
        return text("Saisi.");
      case "choisir": {
        const option = String(input.option ?? "");
        await this.loc(input.ref)
          .selectOption({ label: option }, { timeout: 8000 })
          .catch(() => this.loc(input.ref).selectOption(option, { timeout: 8000 }));
        await this.settle();
        return text("Choisi.");
      }
      case "deposer": {
        const name = String(input.fichier ?? "");
        const file = this.opts.fixtures[name];
        const available = Object.keys(this.opts.fixtures);
        if (!file) return text(`Fichier inconnu. Disponibles : ${available.join(", ") || "(aucun)"}`);
        await this.loc(input.ref).setInputFiles(file, { timeout: 8000 });
        await this.settle();
        return text(`Déposé ${name}.`);
      }
      case "se_connecter": {
        const role = String(input.role ?? "");
        const path = this.opts.accounts[role];
        if (!path) return text(`Pas de compte pour « ${role} ». Rôles disponibles : ${Object.keys(this.opts.accounts).join(", ") || "(aucun)"}`);
        await page.context().clearCookies();
        await page.goto(this.origin + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.evaluate("try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}");
        await page.goto(this.origin + path, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await this.settle();
        return text(`Connecté en ${role}. URL : ${this.url()}`);
      }
      case "capture": {
        if (this.captures >= MAX_CAPTURES) return text(`Plafond de ${MAX_CAPTURES} captures atteint : utilise lire.`);
        const buf = await page.screenshot({ type: "png" });
        this.captures += 1;
        writeFileSync(join(this.opts.capturesDir, `capture-${this.captures}.png`), buf, { mode: 0o600 });
        return [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }];
      }
      default:
        return text(`Outil inconnu : ${name}`);
    }
  }

  /** Écran final (si une page est ouverte) puis fermeture du navigateur. */
  async close(withFinalCapture: boolean): Promise<void> {
    try {
      if (withFinalCapture && this.page) {
        writeFileSync(this.opts.finalCapture, await this.page.screenshot({ type: "png" }), { mode: 0o600 });
      }
    } catch {
      /* page cassée : pas d'écran final */
    }
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }
}
