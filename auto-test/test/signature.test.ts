import { test } from "node:test";
import assert from "node:assert/strict";
import { signBody, SIGNATURE_HEADER } from "../src/signature.ts";

const BODY = '{"type":"started","runId":"00000000-0000-4000-8000-000000000000"}';
// Vecteur calculé indépendamment : printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-secret
const EXPECTED = "sha256=255e1f9cd9a9d274e2a06e70a6350da2b6249d4b9d4687d343023fcb76578eb0";

test("signature HMAC-SHA256 au format sha256=<hex>", () => {
  assert.equal(signBody(BODY, "test-secret"), EXPECTED);
});

test("un \\n final collé dans le secret ne change pas la signature", () => {
  assert.equal(signBody(BODY, "test-secret\n"), EXPECTED);
});

test("la signature dépend du corps exact", () => {
  assert.notEqual(signBody(BODY + " ", "test-secret"), EXPECTED);
});

test("en-tête attendu par feedback-app", () => {
  assert.equal(SIGNATURE_HEADER, "X-Scouad-Signature-256");
});
