---
name: comprehension
description: >
  Sas d'entrée (É3, feedback-app#170/#191), lane amélioration/fonctionnalité :
  reformule systématiquement le ticket brut (souvent une phrase, écrite à
  chaud) en compréhension exploitable par un plan, avant que le ticket entre
  en estimation. Invoqué par le stage `comprehension` (workflow
  `claude-comprehension.yml`) à chaque nouveau ticket non-bug quand
  `precheckEnabled` est actif pour le projet.
---

# comprehension — sas d'entrée, lane amélioration/fonctionnalité

Le ticket brut d'un client n'est presque jamais un besoin exploitable tel
quel — c'est une phrase écrite à chaud, sans critères d'acceptation ni
périmètre. Ce skill transforme ce brut en une reformulation que le stage
`estimate` (et plus tard `plan`) peut consommer sans deviner.

Lire `.claude/skills/_shared/clarification-axes.md` avant de reformuler — les
5 axes (Périmètre, Comportement, Conditions, Cohérence code, Critère
d'acceptation) structurent les étapes 2 et 3 ci-dessous.

## Étape 1 — reformuler, ne pas résumer

Lire le titre + la description de l'issue (déjà montée dans le workspace,
cf. `steps.ctx.outputs.title`/`body`). Produire `understood` : une
reformulation en langage produit de ce que le client demande, **au présent,
sans jargon technique** — ce texte est potentiellement montré au client
(portail, validation 1 clic). Ne pas ajouter d'exigences que le ticket ne
porte pas ; ne pas retirer de nuance qu'il porte.

Dériver `acceptanceCriteria` (liste courte, vérifiable — "l'utilisateur peut
X", pas "le code fait Y") et `exclusions` (ce que la reformulation exclut
explicitement, pour cadrer un scope qui déborderait sinon — vide si rien à
exclure).

## Étape 2 — au plus 3 questions fermées, une par axe non tranché

Dans l'esprit de `grilling` (une décision à la fois, minimal) mais **sans
échange live** : ce stage tourne headless, les questions posées ici partent
au client de façon asynchrone (Q&A existante, `waiting_client`) — il n'y a
personne à qui les poser une à une maintenant.

Pour chaque question envisagée, identifie **l'axe** qu'elle couvre
(Périmètre, Comportement, Conditions — l'axe Cohérence code se résout à
l'étape 3, jamais par une question au client ; l'axe Critère d'acceptation se
résout en écrivant `acceptanceCriteria`, jamais par une question) et vérifie
qu'aucune source disponible ici (titre, description, code du repo checkouté)
ne le tranche déjà. Une question qui ne correspond à aucun axe, ou dont la
réponse est déjà dans le ticket ou déductible du code, est une question de
confort — ne pas la poser, l'estimateur peut trancher ça seul.

- 0 question si tous les axes pertinents sont déjà tranchés → validation
  client 1 clic (`awaiting_client_validation`).
- 1 à 3 questions **fermées** (réponse en une phrase, pas un roman), une par
  axe réellement bloquant.
- Jamais plus de 3 : au-delà, c'est que la reformulation elle-même est
  encore floue — resserrer `understood` plutôt qu'empiler les questions.

## Étape 3 — vérifier l'axe Cohérence code contre le repo

Si le ticket nomme une fonctionnalité, un écran ou un comportement précis
("le bouton X", "l'export Y", "comme sur l'écran Z"), ce n'est **pas
optionnel** : va vérifier avec Glob/Grep/Read dans le repo checkouté que ça
existe réellement et que le comportement décrit est cohérent avec le code —
pas juste un survol. Voir Axe 4 de `_shared/clarification-axes.md` pour les
signaux qui doivent déclencher cette vérification.

Deux issues possibles :
- **Incohérence confirmée** (le ticket décrit quelque chose qui n'existe pas,
  ou contredit un comportement visible dans le code) → resserrer `understood`
  pour refléter ce qui existe réellement, ou lever une question fermée
  ciblée si la reformulation ne peut pas trancher seule.
- **Cohérent, ou rien de vérifiable** (ticket purement fonctionnel, ne cite
  rien de précis) → passer sans bloquer.

Rester proportionné : ce n'est pas une exploration complète
(`codebase-design`), juste une vérification ciblée sur ce que le ticket cite
explicitement.

## Sortie (contrat `POST /api/agent-callback/precheck`)

```json
{
  "projectId": "...",
  "ghIssueNumber": 123,
  "lane": "comprehension",
  "understood": "...",
  "acceptanceCriteria": ["...", "..."],
  "exclusions": ["..."],
  "questions": ["...", "..."]
}
```

`questions` omis ou vide → `precheck.status` bascule en
`awaiting_client_validation`. `questions` présent (1 à 3) → bascule en
`awaiting_client_answers`, rebond client via le mécanisme Q&A existant.
Aucune décision de routage ici (bug vs amélioration) : la lane est déjà
fixée par le type du ticket avant dispatch.
