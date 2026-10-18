// Filet de sécurité du workflow (step `if: failure() || cancelled()`) : si
// aucun événement final n'a été remis (install en échec, crash du runner, job
// coupé par timeout-minutes), envoie un verdict non concluant pour que le run
// ne reste pas « en cours » dans feedback-app. Un run annulé par un nouveau
// commit est déjà final côté feedback-app : il répond 409, sans effet.
//
// Argument : `cancelled` (job annulé ou temps dépassé) ou `failure`.

import { feedbackAppConfig, readInputs, runDirFor } from "./inputs.ts";
import { ensureRunDir, readTerminal } from "./run-dir.ts";
import { flushPending, sendVerdict } from "./verdict.ts";

const say = (msg: string) => console.log(`[auto-test] ${msg}`);

async function main(): Promise<number> {
  const cause = process.argv[2] === "cancelled" ? "cancelled" : "failure";
  const inputs = readInputs(process.env);
  const config = feedbackAppConfig(process.env);
  if (typeof inputs === "string" || typeof config === "string") {
    say("repli impossible : entrées ou configuration invalides");
    return 1;
  }
  const runDir = runDirFor(process.env, inputs.runId);
  ensureRunDir(runDir);
  if (readTerminal(runDir)) {
    say("événement final déjà remis : rien à faire");
    return 0;
  }
  if ((await flushPending(config, runDir)) === "sent") {
    say("verdict en attente remis");
    return 0;
  }
  const reason = cause === "cancelled" ? "temps dépassé" : "erreur du runner";
  const res = await sendVerdict(
    { config, runDir, projectId: inputs.projectId, runId: inputs.runId, startedAt: Date.now() },
    {
      status: "inconclusive",
      summary:
        cause === "cancelled"
          ? "Le test a été interrompu (temps maximal du runner atteint ou annulation) avant d'avoir rendu son verdict."
          : "Le test n'a pas pu aller au bout : erreur technique du runner.",
      reservations: [],
      reason,
    },
  );
  say(`verdict de repli (${reason}) : ${res === "pending" ? "NON remis" : "remis"}`);
  return res === "pending" ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    say("repli en échec");
    process.exit(1);
  });
