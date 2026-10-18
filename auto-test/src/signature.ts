import { createHmac } from "node:crypto";

// Même schéma que feedback-app (`src/lib/services/auto-test-signature.ts`) :
// HMAC-SHA256 du corps brut, en-tête `X-Scouad-Signature-256: sha256=<hex>`.

export const SIGNATURE_HEADER = "X-Scouad-Signature-256";

/** Signature d'un corps (`sha256=<hex>`). Blancs finaux retirés (`\n` final collé). */
export function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret.trimEnd()).update(body).digest("hex");
}
