#!/bin/bash
# Re-vendorise les briques de skills/skills-lock.json et vérifie les hashes.
# Usage : scripts/sync-skills.sh [--check]
#   --check : vérifie seulement que vendor/ correspond au lock (CI), ne télécharge rien.
set -euo pipefail
cd "$(dirname "$0")/.."

LOCK=skills/skills-lock.json
MODE="${1:-sync}"
FAIL=0

for name in $(jq -r '.skills | keys[]' "$LOCK"); do
  source=$(jq -r ".skills[\"$name\"].source" "$LOCK")
  ref=$(jq -r ".skills[\"$name\"].sourceRef" "$LOCK")
  skill_path=$(jq -r ".skills[\"$name\"].skillPath" "$LOCK")
  vendor_path=$(jq -r ".skills[\"$name\"].vendorPath" "$LOCK")
  expected=$(jq -r ".skills[\"$name\"].computedHash" "$LOCK")
  dir="${skill_path%/SKILL.md}"

  if [ "$MODE" != "--check" ]; then
    rm -rf "$vendor_path"
    mkdir -p "$vendor_path"
    gh api "repos/$source/git/trees/$ref?recursive=1" \
      -q ".tree[] | select(.type==\"blob\") | select(.path | startswith(\"$dir/\")) | .path" | while read -r f; do
      rel="${f#"$dir"/}"
      mkdir -p "$vendor_path/$(dirname "$rel")"
      curl -sf "https://raw.githubusercontent.com/$source/$ref/$f" -o "$vendor_path/$rel"
    done
  fi

  actual=$(shasum -a 256 "$vendor_path/SKILL.md" | cut -d' ' -f1)
  if [ "$actual" = "$expected" ]; then
    echo "OK   $name"
  else
    echo "FAIL $name — hash $actual ≠ lock $expected (bump computedHash si le bump de ref est voulu)"
    FAIL=1
  fi
done

exit $FAIL
