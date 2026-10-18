// Réglages du test automatique, fixés par le cadrage (feedback-app #503 / #505).

export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "high";
/** Tours du run principal (annoncés à l'agent comme budget). */
export const MAX_TURNS = 80;
/** Tours de la reprise « conclusion forcée » (--resume) : juste l'outil verdict. */
export const CONCLUSION_MAX_TURNS = 3;
/** Captures demandées par l'agent (outil capture) ; l'écran final s'y ajoute. */
export const MAX_CAPTURES = 4;

/**
 * Échéance interne de l'agent. Le job a `timeout-minutes: 20` : un kill du job
 * n'envoie rien, donc on coupe `claude` avant (install ~2-3 min, conclusion et
 * envoi du verdict ensuite).
 */
export const AGENT_DEADLINE_MS = 12 * 60_000;
/** Temps minimal restant pour tenter la conclusion forcée. */
export const CONCLUSION_MIN_MS = 90_000;
/** Plafond de la reprise « conclusion forcée ». */
export const CONCLUSION_DEADLINE_MS = 3 * 60_000;

/** Nom du serveur MCP : les outils sont exposés en mcp__scouad-test__<outil>. */
export const MCP_SERVER_NAME = "scouad-test";
