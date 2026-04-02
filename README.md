# Claude Workflows (Reusable)

Workflows GitHub Actions reutilisables pour l'automatisation du cycle de developpement avec Claude.

## Workflows disponibles

| Workflow | Trigger (label) | Description |
|----------|----------------|-------------|
| `claude-plan.yml` | `claude-ready` | Genere un plan d'implementation + score de confiance |
| `claude-dev.yml` | `plan-approved` | Implemente le plan, cree une PR |
| `claude-estimate.yml` | `estimate-ready` | Estimation T-shirt sizing + sync Plane |
| `claude-pr-review.yml` | PR opened / `review-ready` | Review automatique de la PR |

## Utilisation

### 1. Pre-requis

- Ce repo doit etre dans la meme organisation GitHub que les projets (ou etre public)
- Les projets doivent avoir un self-hosted runner configure

### 2. Secrets requis (au niveau org ou repo)

| Secret | Requis | Usage |
|--------|--------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Oui | Authentification Claude Code Action |
| `TELEGRAM_BOT_TOKEN` | Non | Notifications Telegram (estimations) |
| `PLANE_API_TOKEN` | Non | Sync estimations vers Plane |

### 3. Variables repo (Settings > Variables)

| Variable | Requis pour | Exemple |
|----------|------------|---------|
| `TELEGRAM_CHAT_ID` | claude-estimate | `7149509278` |
| `PLANE_BASE_URL` | claude-estimate | `https://api.plane.so` |
| `PLANE_WORKSPACE` | claude-estimate | `scouad` |
| `PLANE_PROJECT_ID` | claude-estimate | `uuid-du-projet` |

### 4. Ajouter a un projet

Copiez les fichiers de `examples/` dans `.github/workflows/` de votre projet et adaptez les inputs.

**Exemple minimal (4 fichiers, ~10 lignes chacun) :**

```yaml
# .github/workflows/claude-plan.yml
name: Claude Plan
on:
  issues:
    types: [labeled]
jobs:
  plan:
    if: github.event.label.name == 'claude-ready'
    uses: scouad/claude-workflows/.github/workflows/claude-plan.yml@main
    with:
      base_branch: recette
      project_name: mon-projet
    secrets: inherit
```

### 5. Convention de documentation projet

Les workflows lisent automatiquement tous les fichiers `CLAUDE*.md` a la racine du projet. Utilisez cette convention :

| Fichier | Contenu |
|---------|---------|
| `CLAUDE.md` | Architecture, conventions, guidelines (obligatoire) |
| `CLAUDE_CONTEXT.md` | Contexte metier specifique au projet (optionnel) |
| `CLAUDE_PATTERNS.md` | Patterns de code standardises (optionnel) |

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

## Chaine de labels

```
claude-ready ──→ [claude-plan] ──→ plan-to-review (ou auto plan-approved)
estimate-ready ─→ [claude-estimate] ──→ estimated
plan-approved ──→ [claude-dev] ──→ review-ready
review-ready ───→ [claude-pr-review] ──→ review postee
```
