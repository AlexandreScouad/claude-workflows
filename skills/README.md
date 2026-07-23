# skills/ — catalogue des skills Scouad

Source de vérité des skills consommés par les runs **async** (dispatch depuis la base Cockpit).
Réf. brief : `feedback-app/briefs/design_handoff_cockpit_ops/` — architecture 4c (anatomie des skills), décision R2 (skills épinglés, jamais forkés en silence).

## Structure

```
skills/
├── skills-lock.json      # briques mattpocock/skills épinglées (ref + hash)
├── vendor/               # copies vendorisées des briques du lock — NE PAS ÉDITER
│   ├── code-review/      # critère PR 1 (fait ce que le ticket demande)
│   ├── zoom-out/         # critère PR 2 (minimalité) — supprimée upstream, épinglée à 221ffca
│   ├── caveman/          # critère PR 2 (minimalité) — supprimée upstream, épinglée à 221ffca
│   ├── codebase-design/  # critère PR 3 (se pose au bon endroit)
│   ├── domain-modeling/  # critère PR 3 + decoupage-feature
│   ├── tdd/              # critère PR 4 (prouvé par des tests)
│   ├── handoff/          # critère PR 6 (réversible & lisible)
│   ├── diagnosing-bugs/  # ex-« diagnose » (renommée upstream)
│   └── grilling/         # composée par les skills d'intake (interview-spec…)
└── <skill-scouad>/       # orchestrateurs Scouad, à venir (voir « Catalogue cible »)
```

## Règles (décisions d'architecture validées, ne pas rediscuter)

1. **Composer avant d'écrire** : un skill Scouad fait **< 100 lignes** — frontmatter de
   déclenchement, contrat d'entrées/sorties DB, composition de briques `vendor/`, garde-fous.
   La connaissance lourde vit dans les briques upstream et les docs du repo cible
   (`CONTEXT.md`, ADRs).
2. **R2 — épinglé, jamais forké en silence** : on ne modifie **jamais** un fichier de
   `vendor/`. Une brique upstream s'améliore → on bump `sourceRef` dans le lock et on
   relance `scripts/sync-skills.sh`. Besoin d'un comportement différent → un skill Scouad
   fin par-dessus, pas une édition de la brique.
3. **R1 — la DB est le contrat** : chaque skill écrit sa sortie en DB avec un schéma
   stable ; l'agent qui l'exécute est interchangeable.

## Catalogue cible (architecture 4c)

`verif-bug`, `comprehension` (sas 2a) · `ajustement`, `requalification`, `brief-conductor`
(flux 1d) · `brief-vague` (2b) · `decoupage-feature` (1f/4a) · `interview-spec` (1g) ·
`pr-review` (orchestrateur des 6 critères, 4b) · `securite-tenant` (seul gate à écrire, 4b) ·
`ops-runbook` (assistant, 1c). Chacun arrive avec son ticket wayfinder (carte
[feedback-app#162](https://github.com/AlexandreScouad/feedback-app/issues/162)).

## Montage dans le conteneur d'exécution

Les workflows de ce repo tournent **dans** `claude-workflows` (workflow_dispatch /
repository_dispatch) puis font `actions/checkout` du repo **cible**. Les skills n'existent
donc dans le workspace que si on les monte explicitement. Étapes à insérer **avant**
`anthropics/claude-code-action`, dans tout job qui doit invoquer un skill :

```yaml
- name: Monter le catalogue de skills
  uses: actions/checkout@v4
  with:
    repository: AlexandreScouad/claude-workflows
    ref: ${{ github.sha }}          # même version que le workflow qui tourne
    path: .claude-workflows-skills
    sparse-checkout: skills

- name: Installer les skills dans le workspace cible
  run: |
    mkdir -p .claude/skills
    # briques vendorisées puis skills Scouad (les Scouad écrasent en cas de collision)
    for src in .claude-workflows-skills/skills/vendor .claude-workflows-skills/skills; do
      for d in "$src"/*/; do
        name=$(basename "$d")
        [ "$name" = "vendor" ] && continue
        rm -rf ".claude/skills/$name"
        cp -R "$d" ".claude/skills/$name"
      done
    done
    rm -rf .claude-workflows-skills   # ne jamais committer le catalogue dans le repo cible
```

**Versionnage** : `ref: ${{ github.sha }}` garantit que le run consomme exactement les
skills du commit `claude-workflows` qui exécute le workflow — un rollback du workflow
rollback aussi les skills. **Collision** : pour un run async, le catalogue monté fait foi et
écrase un éventuel skill homonyme du repo cible (comportement uniforme quel que soit le
repo/org cible — le repo Cockpit n'embarque aucun skill).

## Cohabitation avec `feedback-app/.claude/skills/`

| | `claude-workflows/skills/` | `feedback-app/.claude/skills/` + lock racine |
|---|---|---|
| **Consommé par** | runs async (dispatch DB → GitHub Actions), tous repos cibles | sessions interactives Claude Code dans feedback-app |
| **Contenu** | skills Scouad ops/review + briques `vendor/` qu'ils composent | briques mattpocock pour le dev interactif (wayfinder, grilling, prototype…) + skills maison web (scouad-tshirt-estimation) |
| **Évolution** | ce lock-ci | le lock de feedback-app (indépendant) |

La duplication de briques entre les deux locks est **assumée** : chacun épingle sa version
et s'upgrade à son rythme. La skill `scouad-tshirt-estimation` reste côté feedback-app (elle
est aussi compilée dans `skill-prompt.generated.ts` pour le web) ; la grille t-shirt de
`claude-estimate.yml` reste inline dans le prompt.

## Mettre à jour une brique

```bash
# 1. bumper sourceRef (et pinnedRef si global) dans skills-lock.json
# 2. re-vendoriser + vérifier les hashes
scripts/sync-skills.sh
# 3. committer lock + vendor/ ensemble, PR normale
```

## Écarts connus vs brief

- `diagnose` → renommée `diagnosing-bugs` upstream ; le lock épingle la nouvelle.
- `zoom-out` et `caveman` ont été **supprimées** de `mattpocock/skills` ; épinglées au
  dernier commit qui les contenait (`221ffca96736`). Si elles restent absentes upstream au
  prochain bump, envisager de les adopter comme skills Scouad à part entière (sortir de
  `vendor/`, en devenir propriétaire — ce ne serait plus un fork silencieux mais une adoption
  explicite).
