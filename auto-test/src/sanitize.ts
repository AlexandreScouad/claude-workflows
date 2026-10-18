// Les chemins d'auto-login portent des identifiants dans leur query
// (`/fr/sign-in?email=…&password=…`). Ils ne doivent apparaître ni dans les
// logs publics d'Actions, ni dans ce que voit le modèle, ni dans le journal
// envoyé à feedback-app. Les erreurs Playwright citent l'URL complète
// (« navigating to "https://…?password=…" ») : tout texte sortant passe ici.

/** URL sans query ni hash. */
export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return "(url illisible)";
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Clés INOFFENSIVES dont la valeur reste lisible. Tout le reste est masqué
 * (fail-closed) : un identifiant porté par un paramètre au nom inattendu
 * (`k=…`) ne doit jamais fuir dans les logs publics.
 */
const HARMLESS_KEYS = new Set(["redirect", "next", "lang", "locale", "remember"]);

function addVariants(out: Set<string>, value: string): void {
  if (!value) return;
  out.add(value);
  out.add(safeDecode(value));
  out.add(encodeURIComponent(safeDecode(value)));
}

/**
 * Valeurs à masquer pour des chemins d'auto-login : chemin complet, valeur de
 * CHAQUE paramètre de query (sauf liste blanche HARMLESS_KEYS) et fragment,
 * brutes et décodées (un masque n'attrape qu'une sous-chaîne exacte).
 * Valeurs de moins de 4 caractères ignorées.
 */
export function secretValuesOf(loginPaths: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const path of loginPaths) {
    if (!path) continue;
    out.add(path);
    out.add(safeDecode(path));
    const h = path.indexOf("#");
    const beforeHash = h < 0 ? path : path.slice(0, h);
    if (h >= 0) {
      const fragment = path.slice(h + 1);
      addVariants(out, fragment);
      for (const pair of fragment.split("&")) addVariants(out, pair.includes("=") ? pair.slice(pair.indexOf("=") + 1) : pair);
    }
    const q = beforeHash.indexOf("?");
    if (q < 0) continue;
    for (const pair of beforeHash.slice(q + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = eq < 0 ? "" : safeDecode(pair.slice(0, eq)).trim().toLowerCase();
      const value = eq < 0 ? pair : pair.slice(eq + 1);
      if (HARMLESS_KEYS.has(key)) continue;
      addVariants(out, value);
    }
  }
  return [...out].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

const URL_QUERY_RE = /(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>)]*/g;
const SENSITIVE_PARAM_RE = /\b(password|passwd|pwd|pass|token|secret|code|otp|email|login)=[^&\s"'<>)]*/gi;

/** Expurgeur : valeurs connues → « [compte] », query des URLs retirée, paramètres sensibles masqués. */
export function createSanitizer(secrets: readonly string[]): (text: string) => string {
  const values = [...secrets].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const v of values) out = out.split(v).join("[compte]");
    return out.replace(URL_QUERY_RE, "$1").replace(SENSITIVE_PARAM_RE, "$1=[masqué]");
  };
}

/** Lignes `::add-mask::` pour GitHub Actions (à écrire sur la sortie du step, jamais ailleurs). */
export function maskCommands(secrets: readonly string[]): string[] {
  return secrets
    .filter((v) => v.length >= 4 && !/[\r\n]/.test(v))
    .map((v) => `::add-mask::${v}`);
}
