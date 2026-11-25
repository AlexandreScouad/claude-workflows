# Pilote TokenEconomizer sur `claude-dev`

**Statut :** préparé, **éteint par défaut**. Rien ne change tant que la variable
`TOKENECONOMIZER_REPOS` est vide.

**But :** mesurer si [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
(MIT, papier [arXiv 2610.22732](https://arxiv.org/abs/2610.22732)) réduit les tokens consommés
par l'étape `implement` de `claude-dev.yml` sur nos dépôts clients, sans dégrader les PR.

## Ce que dit la source, et ce qu'il faut en attendre

- Les chiffres publiés (−18,4 à −30,9 % de coût moyen) viennent des auteurs, sur 277 tâches
  SWE-Bench. Pour Claude Code + Opus 4.8 : −30,9 % de coût et **−1,0 point de Pass@1**. Aucune
  validation indépendante à ce jour.
- Le gain vient de l'apprentissage **par dépôt**, au fil des sessions : un fait n'est injecté
  qu'après 3 sessions qui le confirment. Un dépôt client avec peu de tickets n'en tirera
  presque rien.
- Les agents tournent sur l'**abonnement Claude** : le gain éventuel se traduit en quota libéré
  (moins de blocages de limite), pas en euros.

## Ce que fait le pilote

| Mécanisme | Pilote | Pourquoi |
|---|---|---|
| Micro-skills (faits appris sur le dépôt, injectés au début de session) | **activé** | c'est le gain principal visé |
| Loop guard (un juge redirige un tour bloqué sur la même erreur) | **activé** | protège les runs de 100 tours |
| Tool pruning | **coupé** | il écrit dans `.claude/settings.local.json` du checkout, effacé à chaque run |

- Seule l'étape **`implement` de `claude-dev.yml`** est concernée (Opus, 100 tours max : le poste le plus cher).
- Le plugin est chargé via `--plugin-dir`, pour cette seule session. **Rien n'est installé dans
  `~/.claude` du runner** : les autres workflows et dépôts ne le voient pas.
- Le code de TokenEconomizer est **épinglé** sur le commit `fa5604a` (24/11/2026). Changer de
  version impose de relire le diff amont : le plugin tourne sur le runner, avec les secrets de
  l'étape dans son environnement.
- Après la session, l'étape `TokenEconomizer pilot (fold)` « plie » la session (apprentissage)
  de façon synchrone. Le pli détaché du plugin serait tué en fin de job.
- **Le dépôt est public, ses logs Actions aussi.** Rien de ce que le plugin apprend sur un
  dépôt client n'est écrit dans les logs ni dans le résumé du job. Le détail reste sur le
  VPS, sous `$TOKENECONOMIZER_HOME`.
- En cas d'anomalie (variable absente, Python trop ancien, téléchargement impossible), le pilote
  est **ignoré** avec un avertissement et le run continue normalement.

## Phase 0 : prérequis sur le VPS (à faire à la main)

La configuration des runners `claude-workflows` n'est pas versionnée ici
(`/data/coolify/services/…` sur le VPS). Deux choses à vérifier ou ajouter :

1. **Un volume partagé par tous les runners `claude-workflows`.** Sans lui, chaque runner
   apprendrait de son côté : l'apprentissage serait dilué, voire perdu à la recréation du
   conteneur. Dans le `docker-compose.yml` des runners :

   ```yaml
   services:
     runner-1:
       volumes:
         - 'te-state:/te-state'   # ajouter à CHAQUE runner claude-workflows
   volumes:
     te-state:
   ```

   Puis `sudo docker compose up -d`. Les verrous du plugin passent par le système de fichiers,
   ce qui est fiable entre conteneurs d'un même hôte.

2. **Python ≥ 3.10 dans l'image du runner.** À vérifier :

   ```bash
   sudo docker exec <conteneur-runner> python3 --version
   ```

   Si la version est absente ou trop ancienne, installer un Python récent dans l'image et
   renseigner son chemin dans `TOKENECONOMIZER_PYTHON`.

## Variables du dépôt `claude-workflows` (Settings › Secrets and variables › Actions › Variables)

| Variable | Valeur | Rôle |
|---|---|---|
| `TOKENECONOMIZER_REPOS` | `owner/repo-a,owner/repo-b` | dépôts cibles du pilote (vide = pilote éteint) |
| `TOKENECONOMIZER_HOME` | `/te-state` | état partagé (apprentissage, journaux, copie du plugin) |
| `TOKENECONOMIZER_PHASE` | `shadow` (défaut) ou `on` | `shadow` : décide et journalise, n'agit pas |
| `TOKENECONOMIZER_PYTHON` | *(optionnel)* | chemin d'un Python ≥ 3.10 si `python3` ne convient pas |

`claude-dev.yml` est dispatché sur `main` par feedback-app (`src/lib/pipeline/stages.ts`) : les
variables prennent effet **au run suivant**, sans tag ni déploiement.

## Choisir les dépôts pilotes

La requête [`pilote-token-economizer-choix-depots.sql`](pilote-token-economizer-choix-depots.sql)
résume l'étape `implement` de `Claude Dev` sur 60 jours, par projet. Elle est en lecture seule et
ouvre elle-même une transaction `read only` (règle 10 du CLAUDE.md de feedback-app : jamais de
`SET` de session sur `DATABASE_URL`). À lancer depuis la racine de ce dépôt, avec le
`DATABASE_URL` de feedback-app :

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/pilote-token-economizer-choix-depots.sql
```

Par projet, elle donne les runs sur 30 et 60 jours, les tickets, les semaines actives, les
relances par ticket, la médiane et le 75ᵉ percentile des tokens, la part de lecture de cache, le
coût et le dernier run. Elle classe chaque projet ainsi :

- **`candidat`** : au moins 10 runs sur 30 jours et 6 semaines actives sur les 60 derniers jours,
  de quoi boucler les phases 1 et 2 en 10 semaines environ ;
- **`témoin`** : au moins 5 runs sur 60 jours, pour la comparaison sur la même période ;
- **`trop peu de runs`** : ignoré.

Prendre les deux premiers `candidat` et mettre leur colonne `depot` dans `TOKENECONOMIZER_REPOS`.
S'il y en a moins de deux, prendre les deux premières lignes et allonger les phases. Ces
60 jours servent aussi de période « avant » pour la mesure : **garder le résultat** avec la date
du jour.

## Phases

| Phase | Réglage | Durée indicative | Ce qu'on vérifie |
|---|---|---|---|
| 0 | prérequis VPS, `TOKENECONOMIZER_REPOS` = 1 dépôt, `shadow` | 1 run | annotations « TokenEconomizer chargé » et « session pliée » dans le run ; `te doctor` sur le VPS |
| 1 | 2 dépôts, `shadow` | ~10 runs `implement` par dépôt | le plugin enregistre les sessions, propose des faits plausibles, coût de ses propres appels |
| 2 | 2 dépôts, `on` | ~15 runs par dépôt | tokens/coût par run vs avant et vs témoin ; qualité des PR |
| 3 | décision | — | étendre (`claude-plan`, autres dépôts), ajuster ou arrêter |

**Le mode `shadow` ne produit aucune économie** : il sert à valider le fonctionnement et à
mesurer le surcoût du plugin avant de le laisser agir.

Sur le VPS, depuis un runner, dans un checkout du dépôt pilote :

```bash
export TOKENECONOMIZER_HOME=/te-state
TE=/te-state/src/fa5604a3673fb3fa8c9932b942dd210e7afb18f3/plugin/scripts/te
$TE --host claude doctor
$TE --host claude status
$TE --host claude microskills
```

Hors checkout : `$TE --host claude repos`. Journaux de pli : `/te-state/logs/fold-<run_id>.log`.

## Mesure

- **Coût de l'agent :** `claude_usage_runs` (`workflow = 'Claude Dev'`, `step = 'implement'`),
  déjà alimentée par `scripts/report-usage.cjs`. Les runs d'un dépôt pilote après la date
  d'activation sont « avec plugin ». **Noter la date d'activation de chaque phase.**
- **Surcoût du plugin :** ses appels (proposeur de faits, juge) passent par un `claude -p` séparé
  et n'apparaissent **pas** dans `claude_usage_runs`. À lire sur le VPS : `te status` (ligne
  `plugin overhead`) et `ledger.jsonl` sous `/te-state/repos/`.
- **Comparaison :** écart de la médiane de `total_tokens` par run, avant et après activation,
  pour les dépôts pilotes, **moins** l'écart sur la même période pour le groupe témoin (simple
  différence de différences). Avec 15 à 30 runs par dépôt et des tickets hétérogènes, ce sera
  **indicatif, pas significatif**. Le dire tel quel dans la conclusion.
- **Qualité :** nombre de runs `Claude Dev` par ticket (relances), PR marquées `wip:` ou
  refusées en revue, et retours de test. Comparer avec la période précédente.

### Requête de comparaison

[`pilote-token-economizer-comparaison.sql`](pilote-token-economizer-comparaison.sql), en lecture
seule comme la précédente :

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v pilotes='owner/repo-a,owner/repo-b' \
  -v debut_shadow=AAAA-MM-JJ \
  -v debut_on=AAAA-MM-JJ \
  -v surcout_tokens=<tokens du plugin pendant la phase 2, lus par te status> \
  -f docs/pilote-token-economizer-comparaison.sql
```

`fin` (défaut : maintenant) et `surcout_tokens` (défaut : 0) sont facultatifs. La période
« avant » couvre les 60 jours qui précèdent `debut_shadow`. Le témoin regroupe les autres projets
avec au moins 5 runs « avant » et 3 runs « après ». Trois sorties :

1. **Par groupe et par période** (avant, observation, après) : runs, tickets, runs par ticket,
   médiane et 75ᵉ percentile des tokens, coût médian. Plus le même détail pour chaque dépôt
   pilote.
2. **Synthèse :** évolution des médianes chez les pilotes (surcoût du plugin réparti sur leurs
   runs « après ») et chez le témoin, écart en points, évolution des relances, et un **verdict**
   qui applique les critères ci-dessous. Il signale aussi les cas impossibles à trancher : pas de
   témoin, ou moins de 15 runs pilotes « après ».
3. **Mélange des tickets :** part des runs par type et par taille dans chaque groupe et chaque
   période. Si le mélange a nettement changé, l'écart peut venir des tickets et non du plugin.

La période « observation » ne sert pas au calcul. Elle sert de contrôle : les tokens des
pilotes ne doivent pas y bouger, puisque le plugin n'agit pas encore.

### Critères de décision (phase 3)

- **On garde et on étend** si la médiane des tokens par run baisse d'au moins 10 points de plus
  que chez le témoin, surcoût du plugin compris, sans hausse des relances de plus de 0,25 run par
  ticket par rapport au témoin, ni hausse visible des refus de PR.
- **On arrête** si la qualité baisse, si un run est cassé par le plugin, ou si le gain est nul.

## Arrêt et nettoyage

- **Arrêt immédiat :** vider `TOKENECONOMIZER_REPOS` (pris en compte au run suivant).
- **Purge :** `rm -rf /te-state/*` sur le VPS, puis retirer le volume du compose.
- **Retrait du code :** supprimer les étapes `TokenEconomizer pilot (setup)` et `(fold)` et les
  ajouts sur `Implement with Claude` dans `claude-dev.yml`.

## Risques connus

- **Chaîne d'approvisionnement :** du code tiers tourne avec `CLAUDE_CODE_OAUTH_TOKEN` et le
  token GitHub du dépôt client dans son environnement. Parades : commit épinglé, relecture avant
  tout changement de version, plugin limité à une seule étape.
- **Confidentialité :** le plugin conserve sous `/te-state` des extraits des sessions (appels
  d'outils et leurs résultats) des dépôts clients, comme les transcripts que Claude Code garde
  déjà dans `~/.claude` du runner. Ses appels de modèle passent par le même abonnement que
  l'agent. Rien ne sort dans les logs publics.
- **Support Claude Code sous `claude-code-action` :** l'auteur a vérifié le plugin avec `claude -p` et
  `--plugin-dir`, pas sous le SDK de `claude-code-action` (point d'entrée
  `claude-code-github-action`). D'où `TE_MODE=headless` forcé et le pli explicite par
  `session_id`. **La phase 0 sert précisément à le confirmer.**
