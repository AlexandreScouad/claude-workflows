#!/usr/bin/env bash
# Audit migrations: vérifie que toute modification SQL/RPC dans le diff a bien
# un fichier de migration committé dans supabase/migrations/, et lit
# migrations-applied.json (produit par claude-dev) pour détecter les statuts
# bloquants.
#
# Usage:
#   BASE_REF=recette ./.github/scripts/audit-migrations.sh
# Outputs to GITHUB_OUTPUT:
#   migration_status: ok | failed | partial
#   migrations_summary: markdown table for PR body
# Exit code:
#   0 if ok or partial (file-only is acceptable)
#   1 if failed (a migration listed as failed, or SQL change without migration file)
set -euo pipefail

BASE_REF="${BASE_REF:-recette}"
APPLIED_FILE="migrations-applied.json"

# 1. Vérifier qu'aucun changement SQL n'est orphelin
# Heuristique : si le diff contient des mots-clés SQL DDL dans un fichier
# non-migration, c'est suspect.
SQL_KEYWORDS='CREATE FUNCTION|CREATE OR REPLACE FUNCTION|CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY|ALTER POLICY|DROP POLICY|CREATE INDEX|DROP INDEX'

ORPHAN_FILES=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null \
  | grep -v '^supabase/migrations/' \
  | grep -E '\.(sql|ts|tsx)$' \
  || true)

ORPHANS=()
if [ -n "$ORPHAN_FILES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if git diff "$BASE_REF"...HEAD -- "$f" 2>/dev/null | grep -qE "^\+.*($SQL_KEYWORDS)"; then
      ORPHANS+=("$f")
    fi
  done <<< "$ORPHAN_FILES"
fi

# 2. Lister les fichiers de migration ajoutés/modifiés
MIGRATION_FILES=$(git diff --name-only --diff-filter=AM "$BASE_REF"...HEAD 2>/dev/null \
  | grep '^supabase/migrations/.*\.sql$' \
  || true)

# 3. Lire migrations-applied.json si présent
# Le fichier n'est sémantiquement pertinent que si la PR touche des migrations.
# Sans migration dans le diff : on tolère un fichier absent OU invalide (héritage
# d'un ancien run, gitignored depuis 2026-05-26) plutôt que de bloquer toutes les
# PR sans migration. Avec migration : strictness intacte (JSON invalide = fail).
HAS_APPLIED_FILE=false
APPLIED_TABLE=""
FAILED_COUNT=0
if [ -f "$APPLIED_FILE" ]; then
  if ! jq empty "$APPLIED_FILE" 2>/dev/null; then
    if [ -n "$MIGRATION_FILES" ]; then
      echo "::error::$APPLIED_FILE présent mais JSON invalide"
      exit 1
    else
      echo "::warning::$APPLIED_FILE invalide mais aucune migration dans cette PR — fichier ignoré"
    fi
  else
    HAS_APPLIED_FILE=true
    FAILED_COUNT=$(jq '[.migrations[] | select(.status == "failed")] | length' "$APPLIED_FILE")
    APPLIED_TABLE=$(jq -r '
      .migrations[] |
      "| `\(.file)` | \(.status) | \(.reason // "-") |"
    ' "$APPLIED_FILE")
  fi
fi

# 4. Construire le rapport
{
  echo "## Migrations SQL"
  echo ""
  if [ -z "$MIGRATION_FILES" ] && [ ${#ORPHANS[@]} -eq 0 ]; then
    echo "_Aucune migration SQL dans cette PR._"
  else
    if [ -n "$MIGRATION_FILES" ]; then
      echo "**Fichiers ajoutés :**"
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "- \`$f\`"
      done <<< "$MIGRATION_FILES"
      echo ""
    fi
    if [ "$HAS_APPLIED_FILE" = "true" ] && [ -n "$APPLIED_TABLE" ]; then
      echo "**Statut d'application :**"
      echo ""
      echo "| Fichier | Statut | Raison |"
      echo "|---------|--------|--------|"
      echo "$APPLIED_TABLE"
      echo ""
    elif [ -n "$MIGRATION_FILES" ]; then
      echo "_⚠️ Aucun \`migrations-applied.json\` produit. Application manuelle requise post-merge._"
      echo ""
    fi
    if [ ${#ORPHANS[@]} -gt 0 ]; then
      echo "**❌ Modifications SQL orphelines (sans fichier de migration) :**"
      for f in "${ORPHANS[@]}"; do
        echo "- \`$f\`"
      done
      echo ""
    fi
  fi
} > migrations-summary.md

# 5. Exit logic
if [ ${#ORPHANS[@]} -gt 0 ]; then
  echo "::error::${#ORPHANS[@]} fichier(s) avec modifications SQL hors du dossier supabase/migrations/"
  for f in "${ORPHANS[@]}"; do
    echo "  - $f"
  done
  echo "migration_status=failed" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 1
fi

if [ "$FAILED_COUNT" -gt 0 ]; then
  echo "::error::$FAILED_COUNT migration(s) en statut 'failed' dans $APPLIED_FILE"
  jq -r '.migrations[] | select(.status == "failed") | "  - \(.file): \(.reason // "no reason")"' "$APPLIED_FILE"
  echo "migration_status=failed" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 1
fi

if [ -n "$MIGRATION_FILES" ] && { [ "$HAS_APPLIED_FILE" = "false" ] || \
   [ "$(jq '[.migrations[] | select(.status == "file-only")] | length' "$APPLIED_FILE" 2>/dev/null || echo 0)" -gt 0 ]; }; then
  echo "migration_status=partial" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "::warning::Au moins une migration en statut 'file-only' — application manuelle post-merge requise"
else
  echo "migration_status=ok" >> "${GITHUB_OUTPUT:-/dev/null}"
fi

exit 0
