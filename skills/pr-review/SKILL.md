---
name: pr-review
description: >
  Orchestrateur des 6 critères d'une bonne PR (chaîne de review Scouad).
  Invoqué par le workflow claude-pr-review à l'ouverture d'une PR et après
  chaque correction. Compose les briques épinglées (code-review, zoom-out,
  caveman, codebase-design, domain-modeling, tdd, handoff) + le skill
  securite-tenant (critère 5) ; assemble leurs verdicts en une passe complète
  conforme au schéma review_verdicts (feedback-app#173/#178). N'écrit jamais
  lui-même en DB — le workflow poste le résultat à
  POST /api/agent-callback/review, seule source de vérité (R1).
---

# pr-review — orchestrateur des 6 critères

## Portée de cette passe

Scope `full` uniquement (ticket solo) : toujours évaluer les 6 critères ici.
La répartition par sous-ticket de feature (critères 2+4 seuls, la totale sur
la PR de jalon) attend qu'É5 soit chartée — hors périmètre de ce skill.

## Étape 1 — contexte partagé (une seule collecte pour les 6 critères)

- `gh pr diff` (diff complet), `gh pr view` (métadonnées), issue liée si
  détectée (critères d'acceptation + plan de test — fournis par le prompt
  appelant).
- Precheck (reformulation validée du besoin, `tickets.precheck`) : **s'il
  existe** pour ce ticket, le lire et nourrir le critère 1 avec. Il n'existe
  pas encore aujourd'hui (dépend d'É3, feedback-app#169/#170) — dans ce cas
  le critère 1 tourne sans lui. Dégradation attendue, pas un blocage.

## Étape 2 — passer les 6 critères, dans l'ordre

Pour chacun, lire et suivre le skill listé (composition — jamais dupliquer sa
logique ici) et collecter son verdict `{criterion, verdict, summary,
findings[]}` :

1. **Fait ce que le ticket demande** — `.claude/skills/code-review/SKILL.md`
   sur le diff + critères d'acceptation de l'issue liée + plan de test. Si un
   precheck existe, vérifier aussi la reformulation validée qu'il porte ; si
   une URL de preview est connue, un replay navigateur du scénario est un
   plus — sinon se limiter à la lecture du diff (l'infra de replay dédiée est
   le périmètre du futur skill `verif-bug`, pas de celui-ci).
2. **Ne fait que ça (minimal, anti-dette)** — composer
   `.claude/skills/zoom-out/SKILL.md` puis `.claude/skills/caveman/SKILL.md`
   sur le diff.
3. **Se pose au bon endroit** — composer
   `.claude/skills/codebase-design/SKILL.md` puis
   `.claude/skills/domain-modeling/SKILL.md` (CONTEXT.md/ADRs du repo cible
   prioritaires sur les heuristiques).
4. **Prouvé par des tests** — `.claude/skills/tdd/SKILL.md` : les tests
   nouveaux/modifiés échoueraient-ils sans ce diff ? La CI (gate 3) couvre
   déjà l'exécution mécanique — ce critère juge la *pertinence* de la
   couverture, pas son passage.
5. **Sûre** — `.claude/skills/securite-tenant/SKILL.md` (critère 5, jamais
   dupliqué ici).
6. **Réversible & lisible** — `.claude/skills/handoff/SKILL.md` + la règle
   `docs/agents/db-migrations.md` du repo cible si le diff touche une
   migration.

## Étape 3 — sortie

Chaque critère produit exactement `{criterion: 1..6, verdict: pass|warn|fail,
summary, findings: [{severity, file, line?, message}]}` — jamais un verdict
agrégé unique : l'agrégat gate 4 et l'escalade « 2 fails consécutifs » sont
calculés côté serveur (`review-chain.ts`), jamais ici (R1, single-writer).

Deux livrables, produits depuis la **même** évaluation (jamais un recalcul
divergent entre les deux) :

1. Un commentaire PR (`gh pr comment`) lisible : tableau des 6 critères,
   verdict + résumé d'une ligne + findings dépliés.
2. Le fichier `.claude-pr-review-verdicts.json` à la racine du workspace :
   `{"verdicts": [ <les 6 objets criterion 1..6> ]}` — lu par l'étape
   suivante du workflow, jamais committé.

Un diff sans surface pour un critère (ex. docs-only pour le critère 5) =
`pass`, summary explicite ("aucune surface sécurité dans ce diff"), zéro
finding — jamais un critère absent du tableau ou du JSON.
