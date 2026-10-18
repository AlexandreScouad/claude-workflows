// Détection du quota d'abonnement atteint dans la sortie de Claude Code.
//
// La forme exacte en mode `-p` n'est pas documentée : détection tolérante.
// Formes connues / probables :
//   « You've hit your session limit · resets 3pm (Europe/Paris) »
//   « You've hit your weekly limit · resets Oct 20, 5am (UTC) »
//   « You've hit your Opus limit … » / « … Sonnet limit … »
//   « Claude AI usage limit reached|1760000000 »   (ancien format : epoch s)
//
// `resetsAt` est TOUJOURS une date ISO (le webhook refuse sinon) : si l'heure
// de reprise est illisible, repli à maintenant + 1 h, texte brut dans `raw`.

export type QuotaHit = { resetsAt: string; raw: string; parsed: boolean };

const LIMIT_RE = /you(?:'|’|\\u2019)ve hit your (?:[\w-]+ ){0,2}limit/i;
const LEGACY_RE = /usage limit reached\|(\d{9,13})/i;
const GENERIC_RE = /usage limit reached/i;
const RESETS_RE = /resets?\s+(?:at\s+|on\s+)?([^·|"\n\\]{1,80})/i;

const FALLBACK_MS = 60 * 60_000;

/** Cherche un message de quota dans un texte (ligne du stream, stderr). */
export function detectQuota(text: string, now: Date = new Date()): QuotaHit | null {
  const legacy = text.match(LEGACY_RE);
  if (legacy?.[1]) {
    const n = Number(legacy[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    return { resetsAt: new Date(ms).toISOString(), raw: legacy[0], parsed: true };
  }
  const hit = text.match(LIMIT_RE) ?? text.match(GENERIC_RE);
  if (!hit) return null;
  const from = hit.index ?? 0;
  const tail = text.slice(from, from + 300);
  const resets = tail.match(RESETS_RE);
  const raw = (resets ? tail.slice(0, (resets.index ?? 0) + resets[0].length) : hit[0]).trim();
  const when = resets?.[1] ? parseResetText(resets[1], now) : null;
  return when
    ? { resetsAt: when.toISOString(), raw, parsed: true }
    : { resetsAt: new Date(now.getTime() + FALLBACK_MS).toISOString(), raw, parsed: false };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Convertit le texte qui suit « resets » en date :
 *   « in 2h 30m », « in 45 minutes », « 3pm », « 3:30pm », « 15:00 »,
 *   « Oct 20, 5am », « Oct 20 at 5:30am », suivis ou non de « (Fuseau/IANA) »,
 *   ou une date ISO. Sans fuseau : UTC (fuseau du runner).
 */
export function parseResetText(input: string, now: Date = new Date()): Date | null {
  const text = input.trim().replace(/[.,;]+$/, "");

  const iso = text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const d = new Date(iso[0]);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const rel = text.match(/^in\s+(?:(\d+)\s*(?:h|hours?|hrs?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?/i);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms);
  }

  const tzMatch = text.match(/\(([^)]+)\)/);
  const tz = tzMatch?.[1] && isValidTimeZone(tzMatch[1].trim()) ? tzMatch[1].trim() : "UTC";
  const body = text.replace(/\([^)]*\)/, " ").trim();

  const dateMatch = body.match(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/i);
  const monthIdx = dateMatch?.[1] ? MONTHS.indexOf(dateMatch[1].toLowerCase()) : -1;

  // Heure : on retire la partie date pour ne pas lire « 20 » de « Oct 20 ».
  const timeSource = dateMatch && monthIdx >= 0 ? body.replace(dateMatch[0], " ") : body;
  const t = timeSource.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!t?.[1]) return null;
  let hour = Number(t[1]);
  const minute = Number(t[2] ?? 0);
  const ampm = t[3]?.toLowerCase();
  if (!ampm && !t[2]) return null; // « 5 » seul : trop ambigu
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const today = partsIn(now, tz);
  if (monthIdx >= 0 && dateMatch?.[2]) {
    const day = Number(dateMatch[2]);
    let year = today.year;
    let d = zonedToUtc(year, monthIdx, day, hour, minute, tz);
    // « Jan 2 » vu en décembre : l'année suivante.
    if (d.getTime() < now.getTime() - 24 * 3_600_000) {
      year += 1;
      d = zonedToUtc(year, monthIdx, day, hour, minute, tz);
    }
    return d;
  }
  let d = zonedToUtc(today.year, today.month, today.day, hour, minute, tz);
  if (d.getTime() <= now.getTime()) {
    d = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, tz);
  }
  return d;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Composantes de date (mois 0-11) d'un instant dans un fuseau. */
function partsIn(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const get = (type: string) => Number(fmt.formatToParts(date).find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Instant UTC correspondant à une heure murale dans un fuseau. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), tz);
    const offset = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - guess;
    guess = wall - offset;
  }
  return new Date(guess);
}
