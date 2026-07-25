---
name: securite-tenant
description: >
  Critère 5 (« Sûre ») de la chaîne de review PR Scouad : revue sécurité
  contextuelle du diff — fuite inter-tenant, frontière sans auth, secret en
  clair, input non validé. Invoqué par l'orchestrateur claude-pr-review à
  chaque passe complète ; produit le verdict structuré du critère 5.
  Ne duplique pas la CI (audit de dépendances, scan de secrets, CodeQL).
---

# securite-tenant — critère PR 5

Revue de la **sémantique** de sécurité du diff, celle que l'outillage statique
ne voit pas. Le mécanique reste en CI : dépendance vulnérable, secret dans
l'historique git, injection détectable par CodeQL. Un finding que ces outils
attraperaient n'a rien à faire ici.

## Étape 1 — établir le modèle de sécurité du repo cible (avant le diff)

Ne rien supposer : le dériver du repo monté dans le workspace.

1. **Clé(s) de tenant** : lire le schéma DB (Drizzle/Prisma/SQL). La clé de
   tenant est la FK que presque toutes les tables portent (ex. feedback-app :
   `projectId` → `projects`, appartenance via `project_members`). Noter les
   tables qui ne la portent pas (globales) — une écriture dedans depuis un
   contexte tenant est suspecte.
2. **Guards d'auth** : recenser les helpers que les routes existantes appellent
   (ex. feedback-app : `requireSession` / `requireProjectMember` / super-admin
   dans `src/lib/auth/`) et les mécanismes hors-session (signature HMAC de
   webhook, auth d'agent-callback). C'est le référentiel : une route nouvelle
   qui n'en appelle aucun est un finding, pas une question de style.
3. **Convention secrets** : où ils vivent (env, colonnes chiffrées via
   `encrypt`/`decrypt`) et par où ils ne doivent jamais sortir (logs, réponse
   JSON, message d'erreur, prompt d'agent).
4. **Docs** : `CONTEXT.md` / ADRs du repo cible s'ils existent — ils priment
   sur les heuristiques ci-dessus.

## Étape 2 — passer tout le diff, 4 familles

- **A. Fuite inter-tenant** : toute requête, route, chemin de storage ou clé de
  cache touchant une table à clé tenant doit filtrer par le tenant de la
  *session*, jamais par un id fourni par le client sans vérification
  d'appartenance (pattern : intersecter, sinon 403). Vérifier aussi les
  jointures/sous-requêtes qui perdent le filtre, les chemins de storage sans
  préfixe tenant, et la RLS absente d'une table nouvelle quand ses sœurs l'ont.
- **B. Frontière sans auth** : nouvelle route ou action serveur sans guard du
  référentiel ; guard affaibli (session vérifiée mais ni appartenance ni
  rôle) ; webhook/callback sans vérification de signature ; endpoint de
  debug/diagnostic exposé sans rôle admin.
- **C. Secret en clair** : secret persisté en clair là où la convention
  chiffre ; renvoyé dans une réponse JSON ; loggé ; interpolé dans un message
  d'erreur ou un prompt d'agent.
- **D. Input non validé à la frontière** : params/body/headers utilisés sans
  validation dans du SQL brut, un chemin de fichier/storage, une URL de
  redirect ou de fetch, un dispatch de workflow. Entre fonctions internes,
  c'est du typage, pas un finding.

Chaque finding : fichier + ligne + **scénario concret d'exploitation** (quel
acteur, par quelle requête, lit ou écrit quoi chez qui). Pas de « pourrait
potentiellement » : sans scénario, pas de finding.

## Verdict (contrat de sortie)

Sévérité par finding, verdict dérivé mécaniquement — jamais au jugé :

- `fail` : fuite inter-tenant démontrable, frontière mutante sans auth,
  secret en clair persisté ou renvoyé.
- `warn` : validation manquante sans exploitation démontrée, durcissement
  recommandé (rate limit, RLS de défense en profondeur), guard fragile.

`verdict` = `fail` si ≥ 1 finding fail, sinon `warn` si ≥ 1 warn, sinon `pass`.

Sortie remise à l'orchestrateur, conforme au schéma `review_verdicts`
(feedback-app#173) :

```json
{
  "criterion": 5,
  "verdict": "pass | warn | fail",
  "summary": "une phrase, en français",
  "findings": [
    { "severity": "fail | warn", "file": "src/…", "line": 42, "message": "scénario" }
  ]
}
```

Un diff sans surface sécurité (docs, styles, tests purs) = `pass`, summary
« aucune surface sécurité dans ce diff », zéro finding.
