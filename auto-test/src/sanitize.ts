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
 * Valeurs à masquer pour des chemins d'auto-login : chemin complet et chaque
 * valeur de paramètre, brutes et décodées (un masque n'attrape qu'une
 * sous-chaîne exacte). Les valeurs de moins de 4 caractères sont ignorées
 * (masquer « fr » ou « 1 » rendrait les logs illisibles sans rien protéger).
 */
export function secretValuesOf(loginPaths: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const path of loginPaths) {
    if (!path) continue;
    out.add(path);
    out.add(safeDecode(path));
    const q = path.indexOf("?");
    if (q < 0) continue;
    for (const pair of path.slice(q + 1).split(/[&#]/)) {
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!pair.includes("=") || !value) continue;
      out.add(value);
      out.add(safeDecode(value));
      out.add(encodeURIComponent(safeDecode(value)));
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
