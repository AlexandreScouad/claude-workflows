---
name: app-context
description: >
  Génère le contexte projet d'un repo client — (1) un résumé applicatif :
  ce que fait l'app, ses entités principales, son vocabulaire métier, pour
  `projects.appContext` ; (2) un contexte technique : architecture,
  patterns de test, fichiers protégés, conventions de code, pour
  `widgetConfig.devContext` (feedback-app). Invoqué par le workflow
  `claude-app-context.yml`.
---

# app-context — contexte métier + technique du projet

Deux touchpoints en aval de feedback-app manquent chacun d'un contexte
différent, comblés par ce skill en un seul run :

- `qualify()` (live, pendant que le client tape) n'a ni accès au code ni
  contexte sur l'application — il ne sait pas ce qu'est "un Bac" ou "une
  Vague" pour un client donné. Comblé par le **résumé applicatif**
  (`appContext`).
- Le pipeline de génération de plan de fix (accès au repo, mais pas à
  l'historique humain du projet) ne connaît ni les conventions de test
  réelles du repo, ni les fichiers sensibles à ne pas toucher. Comblé par le
  **contexte technique** (`devContext`).

Produire les deux en un seul run — un seul checkout de repo, un seul
résumé de chacun, pas destinés au client.

## Partie 1 — résumé applicatif (`appContext`)

### Étape 1 — chercher une source déjà écrite

Chercher dans le repo checkouté, dans cet ordre de priorité : `CONTEXT-MAP.md`
et les `CONTEXT.md` qu'il référence, sinon `CLAUDE.md` (sections décrivant le
projet/domaine), sinon `README.md`. Si l'une de ces sources existe et décrit
le domaine métier (pas seulement la stack technique), c'est la base
principale du résumé — ne pas la réécrire de zéro, la condenser.

### Étape 2 — combler ce que la doc ne dit pas

Si aucune doc de domaine n'existe, ou si elle ne couvre que la stack
technique, explorer légèrement la structure du repo pour identifier le
domaine : `package.json` (nom, description), schéma de base de données
(tables principales, `schema.ts`/`migrations`/équivalent), routes ou pages
principales. Rester léger — quelques fichiers, pas une exploration complète
(`codebase-design`) : l'objectif est de nommer les entités et le vocabulaire
métier, pas de documenter l'architecture.

Si le repo ne permet vraiment rien de déduire (mono-repo vide, structure
générique sans indice de domaine), produire un résumé minimal honnête ("app
[nom du repo], domaine non identifiable depuis le code — à compléter
manuellement par l'admin") plutôt que d'inventer un domaine plausible mais
faux.

### Étape 3 — rédiger le résumé

Écrire en français, ~150 à 300 mots, un seul bloc de texte (pas de
markdown/listes) :
- Ce que fait l'application, en une ou deux phrases.
- Les entités principales et leurs relations (ex. "un Bac regroupe plusieurs
  tickets à traiter ensemble").
- Le vocabulaire métier propre au client (les mots qu'un ticket va utiliser
  et qu'il faut savoir interpréter).

Ce texte est lu par une IA de qualification, pas par un humain non-technique
— rester factuel et dense, pas de tournures commerciales.

## Partie 2 — contexte technique (`devContext`)

Consommé plus tard par le pipeline de génération de plan de fix (qui, lui,
a accès au repo) — ne pas répéter ce que ce pipeline peut lire lui-même,
donner seulement ce qu'une lecture ponctuelle du repo ne referait pas à
chaque run : les conventions réellement suivies et les zones sensibles.

### Architecture (`architectureNotes`)

2-5 phrases factuelles : framework et version majeure, conventions
structurelles réellement observées dans le repo (ex. "Server Components par
défaut", "logique métier dans `src/lib/services/`"), pas une liste
exhaustive de la stack — seulement ce qui aide à situer où un fix doit
s'insérer.

### Patterns de test (`testPatterns`)

Array de globs correspondant aux fichiers de test **réellement présents**
dans le repo (déduits de `package.json` scripts `test`/config du test
runner et de la convention de nommage observée, ex.
`**/__tests__/*.test.ts`) — pas une convention générique si le repo n'en a
pas. Array vide si le repo n'a pas de tests.

### Fichiers protégés (`protectedPaths`)

Array de chemins que l'IA de fix ne doit **pas** modifier sans revue
humaine explicite : schéma de base de données/migrations, fichiers de
config CI/déploiement, secrets/`.env*`, lockfiles, fichiers de config
build (`drizzle.config.ts`, `next.config.ts` ou équivalent). Cette liste a
un vrai impact produit en aval (elle borne ce qu'un agent de fix touche) —
en cas de doute sur un chemin, l'inclure plutôt que l'omettre.

### Conventions de code (`codeStyle`)

1-3 phrases : TypeScript strict ou non, langue du texte visible
(UI/commentaires), conventions de linting/formatage observées
(`.eslintrc`/`biome`/équivalent, présence de `any`/`as` proscrits, etc.).

## Sortie

Écrire **uniquement** `/tmp/app-context-result.json` (Write tool), avec les
deux clés — omettre une clé plutôt que la remplir de valeurs devinées si
l'étape correspondante n'a rien trouvé de fiable :

```json
{
  "appContext": "...",
  "devContext": {
    "architectureNotes": "...",
    "testPatterns": ["..."],
    "protectedPaths": ["..."],
    "codeStyle": "..."
  }
}
```
