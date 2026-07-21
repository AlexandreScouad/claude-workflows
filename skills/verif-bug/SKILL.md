---
name: verif-bug
description: >
  Sas d'entrée (É3, feedback-app#170/#191), lane bug : un agent navigateur
  rejoue le scénario décrit dans le ticket sur le site client (recette puis
  prod) pour confirmer que le bug est réel avant que le ticket entre en
  planning. Invoqué par le stage `verif-bug` (workflow `claude-verif-bug.yml`)
  à chaque nouveau ticket bug quand `precheckEnabled` est actif pour le
  projet.
---

# verif-bug — sas d'entrée, lane bug

Confirme qu'un bug rapporté est réel et toujours présent avant de dépenser un
plan/dev dessus — la moitié des "bugs" reportés sont déjà corrigés (déploiement
entre le signalement et le traitement) ou ne se reproduisent pas tels que
décrits. Compose la discipline `diagnosing-bugs` (Phase 1 — construire une
boucle de feedback) avec un accès navigateur : ici la "boucle" **est** la
session Playwright, pas un test à écrire.

## Contexte disponible au dispatch

- Titre + description du ticket (`steps.ctx.outputs.title`/`body`) — inclut le
  scénario tel que décrit par le client, souvent avec captures d'écran
  (référencées dans le corps, non téléchargeables depuis ce workflow).
- `page_url` (input `workflow_dispatch`) — l'URL **prod** où le bug a été
  remonté (`report_context.pageUrl`, capturé au submit). C'est le seul signal
  fiable : aucun champ "URL recette" n'existe encore côté `projects`
  (feedback-app#191, hors scope — voir "Limite connue" ci-dessous).
- `admin_login_path` (optionnel) — chemin + query string d'auto-login sur le
  site client (même champ que le bouton "Tester"). Absent → naviguer sans
  authentification, en le signalant dans `reproTrace`.

## Étape 1 — construire le scénario de repro

Extraire du ticket : la page/le flux concerné, l'action précise qui déclenche
le bug, le résultat attendu vs observé. Si le scénario est trop vague pour être
rejoué mécaniquement (aucune action décrite, juste "ça marche pas"), ne pas
deviner un scénario — verdict `not_reproduced` avec `reproTrace` expliquant
pourquoi (le rebond client en Q&A demandera alors de préciser).

## Étape 2 — rejouer via Playwright MCP

Naviguer vers `page_url` (auto-login via `admin_login_path` si fourni),
dérouler le scénario extrait à l'étape 1, observer le résultat réel. Capturer
une trace concise (sélecteurs cliqués, message d'erreur/état observé) — pas un
roman, `reproTrace` sert à l'audit et au rebond client, pas à documenter la
session entière.

**Limite connue (assumée à ce stade) :** en l'absence d'une URL recette
distincte, cette étape ne rejoue que sur **prod**. La distinction "reproduit"
vs "reproduit en recette seulement (déjà corrigé)" décidée en #170 suppose une
comparaison recette/prod qui n'est pas encore câblée côté feedback-app — tant
qu'elle ne l'est pas, ce skill ne peut produire que `reproduced` ou
`not_reproduced`, jamais `reproduced_prod_only`. Si le projet pilote expose une
URL recette côté `claude-workflows` (nouvel input `recette_url`, à ajouter
quand le besoin se confirme à l'usage), rejouer recette d'abord puis prod, et
distinguer les trois verdicts normalement.

## Étape 3 — verdict

- **`reproduced`** — le comportement décrit se reproduit sur prod tel quel.
- **`not_reproduced`** — le scénario a été rejoué correctement et le
  comportement décrit ne se produit pas (ou plus).
- **`reproduced_prod_only`** — réservé au cas recette/prod distinct (voir
  limite ci-dessus) ; ne pas émettre tant que la comparaison n'est pas câblée.

Un verdict `not_reproduced` doit systématiquement porter une `question` claire
pour le client (ex. : "Le comportement décrit ne se reproduit pas sur
[page] — peux-tu confirmer les étapes exactes, ou préciser si tu utilises un
compte/navigateur particulier ?"). Un verdict `reproduced` n'a pas besoin de
question — le ticket avance directement.

## Sortie (contrat `POST /api/agent-callback/precheck`)

```json
{
  "projectId": "...",
  "ghIssueNumber": 123,
  "lane": "bug",
  "reproVerdict": "reproduced | reproduced_prod_only | not_reproduced",
  "reproTrace": "...",
  "question": "..."
}
```

`question` requis si `reproVerdict` ≠ `reproduced` (validé côté callback,
absent → 400). `reproduced` bascule `precheck.status` en `validated`
automatiquement (pas de validation client — décision #170). Les deux autres
verdicts rebondissent sur le client via la Q&A existante
(`awaiting_client_answers`).
