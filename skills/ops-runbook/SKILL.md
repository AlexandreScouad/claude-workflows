---
name: ops-runbook
description: >
  Assistant ops du Cockpit Scouad. Charger ce skill pour toute session de
  diagnostic ou réparation d'état sur la base Cockpit : ticket bloqué,
  auto-validation à annuler, labels incohérents, run zombie, backfill.
  Déclenché par le panneau assistant (⌘K, global ou contexte ticket) ou
  invocable en Claude Code headless. Remplace les scripts one-shot de scripts/.
# ⚠️ Frontmatter appliqué par le CLI Claude Code UNIQUEMENT. Via l'Agent SDK
# (service ops-assistant du VPS), `allowed-tools` est IGNORÉ : la whitelist
# effective vit dans `options.allowedTools` du service
# (feedback-app/ops-assistant/agent.mjs). Garder les deux listes alignées.
allowed-tools:
  - Skill
  - mcp__ops__check_invariants   # les 7 invariants via le service layer feedback-app
  - mcp__ops__plane_issue        # lecture issue Plane live via le service layer
  - mcp__db                      # SQL lecture seule (rôle ops_assistant_ro)
  - mcp__github                  # MCP GitHub distant en mode lecture (X-MCP-Readonly)
---

# Ops Runbook — Cockpit

## Périmètre & règles absolues

1. **Base Cockpit uniquement.** Jamais le code des projets clients (ça, c'est le pipeline / Conductor).
2. **Lecture libre, mutation par le service layer.** Toute écriture passe par les
   fonctions whitelistées du service layer (les mêmes que l'UI). JAMAIS de SQL
   UPDATE direct : les invariants et la projection Plane doivent rester garantis.
3. **Toute opération est journalisée** dans `ops_log` : `{operation, ticket(s),
   before, after, level, confirmedBy, rollbackOp, at}`. Pas de log = pas d'exécution.
4. **Un doute = un niveau au-dessus.** Si une opération pourrait être ambre ou
   rouge, elle est rouge.
5. **2 échecs sur la même réparation = STOP** → générer un brief (skill
   `brief-conductor`) et rendre la main à Alexandre.

## Niveaux d'autonomie

| Niveau | Quoi | Confirmation |
|---|---|---|
| 🟢 VERT | Lectures : DB, Plane, GitHub, runs, checks d'invariants | Aucune — exécuter directement |
| 🟠 AMBRE | Transition réversible sur 1–3 tickets : état, label, relance de run, requalification | Carte diff avant/après, 1 clic |
| 🔴 ROUGE | Irréversible, en masse (>3 tickets), ou touche la facturation | Dry-run ligne à ligne obligatoire, puis confirmation explicite (globale ou ticket par ticket) |

## Séquence type d'une session

1. **Diagnostiquer d'abord** (vert) : lire le ticket, ses runs, ses labels, son
   lifecycle ; passer les 7 invariants. Ne JAMAIS proposer une mutation sans
   avoir posé un diagnostic sourcé (« detect-external-validation a écrit X le
   18/07, aucune action client dans issue_lifecycle »).
2. **Chercher les frères** : si un ticket viole un invariant, requêter les
   autres tickets dans le même cas et le signaler.
3. **Proposer la réparation** au bon niveau, avec le diff avant/après et
   l'opération de rollback.
4. **Exécuter après confirmation**, journaliser, re-vérifier l'invariant.

## Les 7 invariants → réparation type

Source : PROCESS.md §Invariants + outil `check_invariants` (= `GET /api/admin/diagnostics/invariants`, rapport INV-1..7).

### INV-1 · Type label unique
Ticket actif sans (ou avec plusieurs) label de type {Bug, Amelioration, Fonctionnalite}.
- Détection 🟢 : `getIssueTypeFromLabels === null` sur ticket actif (badge `_uncategorized`).
- Réparation 🟠 : poser le type suggéré par `type-suggestion` (ou celui indiqué par Alexandre) via la route type. Rollback : retirer le label.

### INV-2 · État Plane résolu
State utilisé par les routes non résolvable par `findStateId`.
- Détection 🟢 : `stateNotResolved` au diagnostics.
- Réparation 🔴 : ajouter l'alias de state (config) — jamais renommer côté Plane. Signaler que `merge-recette` throw et `merge-prod` skip en attendant.

### INV-3 · Validation client cohérente
`estimations.validatedAt` non nul mais state Plane hors {Todo, In Progress, À tester, Rejet à valider, Done}.
- Détection 🟢 : `validatedWithoutPlaneState`.
- Réparation 🟠 : rejouer le PATCH state via service layer (la DB a raison : DB-first). Équivalent legacy : `unvalidate-estimation` pour le sens inverse (🟠, rollback trivial).

### INV-4 · Question répondue cohérente
`answeredAt` non nul + state encore `En attente client` (ou l'inverse).
- Détection 🟢 : `questionAnsweredOrphan` / `questionAskedOrphan`.
- Réparation 🟠 : re-projeter le state depuis la DB. Équivalents legacy : `fix-answer-spaces`, `diag-answer-spaces`.

### INV-5 · Cohérence labels pipeline
Combinaisons interdites : `plan-to-review`+`plan-approved` · `merged-recette`+`review-ready` · `correction-ready`+`merged-recette`.
- Détection 🟢 : `pipelineOrphan` (classifié `conflicting_labels`).
- Réparation 🟠 : retirer le label périmé selon l'étape réelle (déduite des runs + PRs). Équivalents legacy : `unstick-pr-review`, `unstick-auto-approved-plan`, `requalify-orphan-pr-review`.

### INV-6 · Itération cohérente
`iteration ≥ 1`, incrémentée uniquement par `recordCorrection`, jamais décrémentée.
- Détection 🟢 : delta entre iteration et le nombre de `confirm-rejection` du lifecycle.
- Réparation 🔴 : correction manuelle du compteur = rouge (touche l'historique de facturation des retours). Dry-run + confirmation obligatoires.

### INV-7 · Idempotence des transitions
Un retry de route doit aboutir au même état final.
- Détection 🟢 : erreurs 422 GitHub sur retry (`merge-prod` rejoue `mergeToRecette`).
- Réparation 🟠 : reprendre la transition à l'étape réellement atteinte (lire l'état GitHub d'abord), pas depuis le début.

## Catalogue d'opérations

Dérivé des scripts existants — chaque entrée remplace un fichier `scripts/*.ts`.
Format : `nom · niveau · pré-conditions · mutation · rollback`.

### Diagnostics (🟢, sans confirmation)
- `diagnose-ticket <ref>` — état complet : DB, Plane, labels, runs, PRs, invariants. (ex `diagnose-ticket.ts`, `diag-cockpit-plan.ts`)
- `check-pipeline [projet]` — runs en cours, zombies, stages en retard. (ex `check-pipeline.ts`, `diag-pipeline-progress.ts`)
- `diag-gates <ref|aggregate>` — verdicts des critères PR. (ex `diag-gates-ticket.ts`, `diag-gates-aggregate.ts`, `diag-pr-review-gates.ts`)
- `list-waiting [projet]` — tickets en attente client / de vague. (ex `list-waiting.ts`)
- `check-invariants [projet|ticket]` — les 7 checks ci-dessus, via l'outil `check_invariants`. (ex `/api/admin/diagnostics/invariants`, `check-confiance-cost-integrity.ts`, `run-projection-validator.ts`)

### Transitions unitaires (🟠, carte de confirmation)
- `set-state <ref> <state>` — pré : state cible résolvable (INV-2) ; mutation service layer + projection ; rollback : state précédent (journalisé).
  (ex `move-to-rejet-a-valider.ts`, `reset-to-clarify.ts`)
- `unstick <ref>` — pré : diagnostic posé identifiant l'étape réelle ; mutation : labels/state realignés sur l'étape ; rollback : jeu de labels précédent.
  (ex famille `unstick-*.ts` : plan, dev-after-plan, pr-review, clarify-drag, conductor-correction, rejected-state, stuck-replan, stuck-plan-dispatch)
- `retry-stage <ref> <stage>` — pré : run précédent en échec/zombie ; mutation : re-dispatch async du stage ; rollback : abandonner la run.
  (ex `force-retry.ts`, `promote-to-pr-review.ts`)
- `revert-auto-validation <ref>` — pré : validation externe détectée sans action client dans lifecycle ; mutation : Done → À tester + re-notification ; rollback : re-poser Done.
  (ex `promote-externally-validated.ts` inverse, cas COCKP-1203)
- `requalify <ref>` — relance le sas (2a) sur un ticket mal parti ; rollback : restaurer precheck précédent.

### Masse & irréversible (🔴, dry-run obligatoire)
- `bulk <opération> WHERE <critère>` — toute opération 🟠 appliquée à >3 tickets. Dry-run : liste ticket par ticket avant/après.
- `backfill <champ>` — pré : migration/feature déployée ; mutation : remplissage historique ; rollback : snapshot des valeurs remplacées dans ops_log.
  (ex famille `backfill-*.ts` : tickets, gates, dates facturation, types)
- `abandon-zombie-runs` — clôture les runs orphelines. (ex `abandon-zombie-pipeline-runs.ts`)
- `billing-fix <op>` — TOUT ce qui touche estimations validées, factures, dates de facturation. Toujours rouge, même unitaire.
  (ex `set-billing-dates-from-invoices.ts`, `set-octave-devis-prices.ts`)
- `config-secret <op>` — clés API, tokens, flags projet. Toujours rouge.
  (ex `set-*-key.ts`, `set-projection-flag.ts`, `enable-pipeline-dispatch.ts`)

### Hors périmètre (refuser + rediriger)
- Modifier du code client → `brief-conductor`.
- Créer/supprimer un projet, migrer la DB → Alexandre à la main (`run-migration.ts`).
- Contourner un invariant « juste pour cette fois » → refuser, proposer la réparation conforme.

## Escalade

- 2 échecs de la même réparation → brief Conductor auto (contexte : diagnostic, tentatives, diffs).
- Invariant violé sur >10 tickets → ne pas réparer en boucle : signaler la cause racine probable (route mutante fautive) avec les références AUDIT-RELIABILITY.
- Toute demande floue sur de la facturation → reformuler et faire confirmer AVANT le dry-run.

## Un cas nouveau

Un problème qui ne matche aucune entrée du catalogue :
1. Diagnostiquer (🟢) et le résoudre en opérations existantes si possible.
2. Sinon, proposer la réparation en ROUGE avec dry-run, quel que soit son volume.
3. Après résolution : proposer l'ajout d'une entrée au catalogue (PR sur ce fichier) —
   c'est comme ça que le catalogue remplace les `fix-cockp-NNNN.ts` un par un.
