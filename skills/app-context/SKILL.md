---
name: app-context
description: >
  Génère un résumé du contexte applicatif d'un repo client — ce que fait
  l'app, ses entités principales, son vocabulaire métier — pour peupler
  `projects.appContext` (feedback-app). One-shot, déclenché manuellement par
  l'admin depuis les réglages projet, jamais par ticket. Invoqué par le
  workflow `claude-app-context.yml`.
---

# app-context — résumé applicatif pour la qualification live

Le touchpoint `qualify()` (feedback-app, live pendant que le client tape) n'a
ni accès au code ni contexte sur l'application — il ne sait pas ce qu'est
"un Bac" ou "une Vague" pour un client donné. Ce skill produit, une fois par
projet, le texte qui comble ce trou : un résumé compact du domaine
applicatif, écrit pour être injecté dans un prompt de qualification — pas un
document technique, pas destiné au client.

## Étape 1 — chercher une source déjà écrite

Chercher dans le repo checkouté, dans cet ordre de priorité : `CONTEXT-MAP.md`
et les `CONTEXT.md` qu'il référence, sinon `CLAUDE.md` (sections décrivant le
projet/domaine), sinon `README.md`. Si l'une de ces sources existe et décrit
le domaine métier (pas seulement la stack technique), c'est la base
principale du résumé — ne pas la réécrire de zéro, la condenser.

## Étape 2 — combler ce que la doc ne dit pas

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

## Étape 3 — rédiger le résumé

Écrire en français, ~150 à 300 mots, un seul bloc de texte (pas de
markdown/listes) :
- Ce que fait l'application, en une ou deux phrases.
- Les entités principales et leurs relations (ex. "un Bac regroupe plusieurs
  tickets à traiter ensemble").
- Le vocabulaire métier propre au client (les mots qu'un ticket va utiliser
  et qu'il faut savoir interpréter).

Ce texte est lu par une IA de qualification, pas par un humain non-technique
— rester factuel et dense, pas de tournures commerciales.

## Sortie

Écrire **uniquement** `/tmp/app-context-result.json` (Write tool) :

```json
{ "appContext": "..." }
```
