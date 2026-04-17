# Claude Workflows (Reusable)

Workflows GitHub Actions reutilisables pour l'automatisation du cycle de developpement avec Claude.

## Workflows disponibles

| Workflow | Trigger (label) | Description |
|----------|----------------|-------------|
| `claude-plan.yml` | `claude-ready` | Genere un plan d'implementation + score de confiance |
| `claude-dev.yml` | `plan-approved` | Implemente le plan, cree une PR |
| `claude-estimate.yml` | `estimate-ready` | Estimation T-shirt sizing + sync Plane |
| `claude-pr-review.yml` | PR opened / `review-ready` | Review automatique de la PR |
| `claude-cleanup.yml` | PR merged | Supprime la branche `claude/issue-*` |

## Utilisation

### 1. Pre-requis

- Ce repo doit etre dans la meme organisation GitHub que les projets (ou etre public)
- Les projets doivent avoir un self-hosted runner configure
- **Repo prive** : activer "Allow access to reusable workflows from private repositories" dans les settings Actions de l'org

### 2. Secrets requis (au niveau org ou repo)

| Secret | Requis | Usage |
|--------|--------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Oui | Authentification Claude Code Action |
| `PLANE_API_TOKEN` | Non | Integration Plane (plan stocke dans custom fields) |
| `TELEGRAM_BOT_TOKEN` | Non | Notifications Telegram (estimations) |

### 3. Variables repo (Settings > Variables)

| Variable | Requis pour | Exemple |
|----------|------------|---------|
| `TELEGRAM_CHAT_ID` | claude-estimate | `7149509278` |
| `PLANE_BASE_URL` | Plane integration | `https://api.plane.so` |
| `PLANE_WORKSPACE` | Plane integration | `scouad` |
| `PLANE_PROJECT_ID` | Plane integration | `uuid-du-projet` |

### 4. Ajouter a un projet

Copiez les fichiers de `examples/` dans `.github/workflows/` de votre projet et adaptez les inputs.

**Exemple minimal (5 fichiers, ~10 lignes chacun) :**

```yaml
# .github/workflows/claude-plan.yml
name: Claude Plan
on:
  issues:
    types: [labeled]
jobs:
  plan:
    if: github.event.label.name == 'claude-ready'
    uses: scouad/claude-workflows/.github/workflows/claude-plan.yml@v1
    with:
      base_branch: recette
      project_name: mon-projet
    secrets: inherit
```

### 5. Convention de documentation projet

Les workflows lisent automatiquement tous les fichiers `CLAUDE*.md` a la racine du projet :

| Fichier | Contenu |
|---------|---------|
| `CLAUDE.md` | Architecture, conventions, guidelines (obligatoire) |
| `CLAUDE_CONTEXT.md` | Contexte metier specifique au projet (optionnel) |
| `CLAUDE_PATTERNS.md` | Patterns de code standardises (optionnel) |

### 6. Integration Plane (optionnel)

Les workflows `claude-plan` et `claude-dev` supportent le stockage du plan dans les custom fields Plane.

**Fonctionnement** :
- Si `PLANE_API_TOKEN` + variables Plane sont configures → le plan est ecrit dans les custom fields du work item Plane lie a l'issue GitHub
- Sinon → fallback vers commentaire GitHub (comportement par defaut)

**Custom fields requis dans Plane** :
- `plan de correction` (type texte) — stocke le plan d'implementation
- `plan de test` (type texte) — stocke le plan de test

Les noms des champs sont configurables via les inputs `plane_plan_field_name` et `plane_test_field_name`.

## Inputs par workflow

### claude-plan.yml

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | string | `recette` | Branche de checkout |
| `project_name` | string | *requis* | Nom du projet |
| `auto_approve_threshold` | number | `60` | Seuil auto-approbation (bugs) |
| `model` | string | `claude-opus-4-6` | Modele Claude |
| `max_turns` | number | `50` | Turns max |
| `extra_prompt` | string | `''` | Instructions specifiques |
| `plane_plan_field_name` | string | `plan de correction` | Nom du champ Plane pour le plan |
| `plane_test_field_name` | string | `plan de test` | Nom du champ Plane pour les tests |

### claude-dev.yml

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | string | `recette` | Branche cible pour la PR |
| `project_name` | string | *requis* | Nom du projet |
| `node_version` | string | `20` | Version Node.js |
| `install_command` | string | `npm ci` | Commande d'install |
| `lint_command` | string | `npm run lint:fix` | Commande lint fix |
| `typecheck_command` | string | `npm run check-types` | Commande typecheck |
| `model` | string | `claude-opus-4-6` | Modele Claude |
| `max_turns` | number | `100` | Turns max |
| `extra_prompt` | string | `''` | Instructions specifiques |
| `plane_plan_field_name` | string | `plan de correction` | Nom du champ Plane pour le plan |
| `plane_test_field_name` | string | `plan de test` | Nom du champ Plane pour les tests |

### claude-estimate.yml

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `base_branch` | string | `recette` | Branche de checkout |
| `project_name` | string | *requis* | Nom du projet |
| `estimation_grid` | string | grille standard | Grille custom (markdown) |
| `model` | string | `claude-sonnet-4-6` | Modele Claude |
| `max_turns` | number | `30` | Turns max |
| `extra_prompt` | string | `''` | Instructions specifiques |

### claude-pr-review.yml

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `project_name` | string | *requis* | Nom du projet |
| `model` | string | `claude-sonnet-4-6` | Modele Claude |
| `max_turns` | number | `15` | Turns max |
| `extra_review_rules` | string | `''` | Regles de review specifiques |

### claude-cleanup.yml

Aucun input — declenche par le caller quand une PR `claude/issue-*` est mergee.

## Chaine de labels

```
claude-ready ──→ [claude-plan] ──→ plan-to-review (ou auto plan-approved)
estimate-ready ─→ [claude-estimate] ──→ estimated
plan-approved ──→ [claude-dev] ──→ review-ready
review-ready ───→ [claude-pr-review] ──→ review postee
PR merged ──────→ [claude-cleanup] ──→ branche supprimee
```

## Versioning

- `@main` — derniere version (pour tester)
- `@v1` — version stable (recommande pour la production)

Les thin callers doivent utiliser `@v1` sauf en phase de test.
