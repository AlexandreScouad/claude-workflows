// Contexte d'un test, servi par feedback-app :
// GET {FEEDBACK_APP_URL}/api/projects/{projectId}/auto-test/context?ticketKey=…
// (Bearer AUTO_TEST_WEBHOOK_SECRET), réponse `{ success, data }`.
//
// `accounts[].loginPath` contient des identifiants : jamais loggé, jamais
// envoyé au modèle (seuls les rôles le sont).

export type RunnerAccount = { role: string; loginPath: string | null };
export type Fixture = { name: string; url: string };

export type AutoTestContext = {
  previewUrl: string;
  ticketTitle: string;
  ticketType: string | null;
  headSha: string | null;
  brief: { problem: string | null; cause: string | null; fix: string | null; quickTest: string | null };
  detailedSteps: string[];
  accounts: RunnerAccount[];
  fixtures: Fixture[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Nom de fichier sûr (pas de chemin) pour un fichier d'exemple. */
export function safeFixtureName(name: string): string | null {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return /^[\w][\w .()-]{0,120}$/.test(base) ? base : null;
}

/** Valide la charge utile `data` de l'endpoint contexte. */
export function parseContext(payload: unknown): AutoTestContext | null {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data) return null;
  const previewUrl = str(data.previewUrl);
  if (!previewUrl) return null;
  try {
    new URL(previewUrl);
  } catch {
    return null;
  }
  const brief = isRecord(data.brief) ? data.brief : {};
  const accounts: RunnerAccount[] = Array.isArray(data.accounts)
    ? data.accounts.filter(isRecord).flatMap((a) => {
        const role = str(a.role);
        return role ? [{ role: role.trim(), loginPath: str(a.loginPath) }] : [];
      })
    : [];
  // Fichiers d'exemple : `{ name, url }` téléchargeables. (L'endpoint renvoie
  // aujourd'hui `[]` ; une forme non reconnue est ignorée.)
  const fixtures: Fixture[] = Array.isArray(data.fixtures)
    ? data.fixtures.filter(isRecord).flatMap((f) => {
        const name = str(f.name) ? safeFixtureName(String(f.name)) : null;
        const url = str(f.url);
        return name && url && /^https:\/\//.test(url) ? [{ name, url }] : [];
      })
    : [];
  return {
    previewUrl,
    ticketTitle: str(data.ticketTitle) ?? "(sans titre)",
    ticketType: str(data.ticketType),
    headSha: str(data.headSha),
    brief: { problem: str(brief.problem), cause: str(brief.cause), fix: str(brief.fix), quickTest: str(brief.quickTest) },
    detailedSteps: Array.isArray(data.detailedSteps) ? data.detailedSteps.filter((s): s is string => typeof s === "string" && !!s.trim()) : [],
    accounts,
    fixtures,
  };
}

/** Rôles réellement utilisables (chemin de connexion présent). */
export function usableRoles(accounts: readonly RunnerAccount[]): string[] {
  return [...new Set(accounts.filter((a) => a.loginPath).map((a) => a.role))];
}
