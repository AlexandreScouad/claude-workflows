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

## Étape 2 — au plus 3 questions fermées, seulement si nécessaire

Dans l'esprit de `grilling` (une décision à la fois, minimal) mais **sans
échange live** : ce stage tourne headless, les questions posées ici partent
au client de façon asynchrone (Q&A existante, `waiting_client`) — il n'y a
personne à qui les poser une à une maintenant. Ne poser que ce qui est
**réellement bloquant** pour un estimateur (périmètre ambigu, comportement
non spécifié sur un cas limite cité) — jamais une question de confort ou de
détail visuel mineur, l'estimateur peut trancher ça seul.

- 0 question si la reformulation est déjà actionnable → validation client
  1 clic (`awaiting_client_validation`).
- 1 à 3 questions **fermées** (réponse en une phrase, pas un roman) si un
  point bloque réellement l'estimation.
- Jamais plus de 3 : au-delà, c'est que la reformulation elle-même est
  encore floue — resserrer `understood` plutôt qu'empiler les questions.

## Étape 3 — vérifier contre le code si le ticket y fait référence

Si le ticket cite une page, un flux ou un comportement existant, vérifier
brièvement dans le repo monté (Glob/Grep/Read) que la reformulation est
cohérente avec ce qui existe réellement — évite une reformulation qui décrit
un comportement halluciné. Rester léger : ce n'est pas une exploration
complète (`codebase-design`), juste un garde-fou de cohérence.

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
