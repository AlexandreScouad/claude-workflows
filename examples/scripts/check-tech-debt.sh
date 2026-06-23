#!/usr/bin/env bash
# Check tech debt: scan added lines in the diff between BASE_REF and HEAD for
# forbidden patterns. A pattern can be exempted by a comment `// reason: ...`
# (>=10 chars of justification) on the line directly above.
#
# Usage:
#   BASE_REF=main ./.github/scripts/check-tech-debt.sh
# Outputs:
#   tech-debt-report.json
#   exit 0 if no blockers, exit 1 if any blocker
#
# Générique (port depuis cockpit). À copier dans .github/scripts/ du repo cible
# puis activer `run_tech_debt_check: true` dans le caller claude-dev. Le workflow
# passe BASE_REF=<base_branch>. Requiert `jq` et `python3` (présents sur
# ubuntu-latest). Adapter PATTERNS aux conventions du projet si besoin.
set -euo pipefail

BASE_REF="${BASE_REF:-main}"
REPORT="tech-debt-report.json"

BLOCKERS_FILE=$(mktemp)
WARNINGS_FILE=$(mktemp)
EXCEPTIONS_FILE=$(mktemp)
trap 'rm -f "$BLOCKERS_FILE" "$WARNINGS_FILE" "$EXCEPTIONS_FILE"' EXIT

# Patterns: regex|severity|category
# Ordering matters: more specific patterns must come BEFORE generic ones,
# because the loop breaks on first match.
#
# Severity rationale:
# - blocker: pattern that DIRECTLY causes runtime bugs or hides regressions
# - warning: code-style preference or technical debt marker, surfaced but non-blocking
PATTERNS=(
  # === BLOCKERS — vrais facteurs de bug ===
  '@ts-nocheck|blocker|ts_nocheck'
  '@ts-ignore|blocker|ts_ignore'
  '\.skip\(|blocker|test_skip'
  '\.todo\(|blocker|test_todo'
  '\bxit\(|blocker|test_xit'
  '\bxdescribe\(|blocker|test_xdescribe'
  '\bdebugger\b|blocker|debugger_stmt'
  '@ts-expect-error[[:space:]]*$|blocker|ts_expect_no_desc'
  # eslint-disable spécifique à react-hooks/exhaustive-deps : cause des bugs de state stale
  'eslint-disable.*react-hooks/exhaustive-deps|blocker|hooks_deps_disabled'

  # === WARNINGS — préférences de style, ne bloquent pas le merge ===
  'as any|warning|cast_any'
  'as unknown as |warning|cast_unknown'
  'eslint-disable|warning|eslint_disable'
  '\bconsole\.log\b|warning|console_log'
  '// TODO|warning|todo_added'
  '// FIXME|warning|fixme_added'
  '^[[:space:]]*// (import|const|let|var|function|export|return) |warning|commented_code'
)

# Get the diff (additions only) with hunk headers so we can track line numbers.
DIFF=$(git diff --unified=0 --no-color "$BASE_REF"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null || echo "")

if [ -z "$DIFF" ]; then
  printf '{"blockers":[],"warnings":[],"exceptions":[]}\n' > "$REPORT"
  echo "No relevant diff against $BASE_REF — tech debt check skipped"
  exit 0
fi

CURRENT_FILE=""
NEW_LINE_NUM=0

# Buffer added lines per file with their new line number.
BUFFER_FILE=$(mktemp)
trap 'rm -f "$BLOCKERS_FILE" "$WARNINGS_FILE" "$EXCEPTIONS_FILE" "$BUFFER_FILE"' EXIT

while IFS= read -r line; do
  if [[ "$line" =~ ^\+\+\+\ b/(.+)$ ]]; then
    CURRENT_FILE="${BASH_REMATCH[1]}"
    continue
  fi
  if [[ "$line" =~ ^@@\ -[0-9,]+\ \+([0-9]+)(,[0-9]+)?\ @@ ]]; then
    NEW_LINE_NUM="${BASH_REMATCH[1]}"
    continue
  fi
  case "$line" in
    +++*|---*) continue ;;
    +*)
      content="${line:1}"
      printf '%s\t%s\t%s\n' "$CURRENT_FILE" "$NEW_LINE_NUM" "$content" >> "$BUFFER_FILE"
      NEW_LINE_NUM=$((NEW_LINE_NUM + 1))
      ;;
    -*)
      ;;
    *)
      NEW_LINE_NUM=$((NEW_LINE_NUM + 1))
      ;;
  esac
done <<< "$DIFF"

is_exempt() {
  local file="$1"
  local lineno="$2"
  local prev=$((lineno - 1))
  if [ "$prev" -lt 1 ] || [ ! -f "$file" ]; then
    return 1
  fi
  local prev_line
  prev_line=$(sed -n "${prev}p" "$file" 2>/dev/null || echo "")
  if [[ "$prev_line" =~ ^[[:space:]]*//[[:space:]]*reason:[[:space:]]*(.{10,})$ ]]; then
    return 0
  fi
  return 1
}

emit_json() {
  # $1 = target file, $2..= file/line/category/content
  local target="$1"
  local file="$2"
  local lineno="$3"
  local category="$4"
  local content="$5"
  python3 -c '
import json, sys
file, line, cat, content = sys.argv[1:]
print(json.dumps({"file": file, "line": int(line), "category": cat, "content": content}))
' "$file" "$lineno" "$category" "$content" >> "$target"
}

while IFS=$'\t' read -r file lineno content; do
  for pat in "${PATTERNS[@]}"; do
    IFS='|' read -r regex severity category <<< "$pat"
    if [[ "$content" =~ $regex ]]; then
      # Test files: tolerate cast_any (mocks legitimately need it)
      if [[ "$file" =~ \.(test|spec)\.(ts|tsx|js|jsx)$ ]] && [ "$category" = "cast_any" ]; then
        emit_json "$EXCEPTIONS_FILE" "$file" "$lineno" "$category" "$content"
      elif is_exempt "$file" "$lineno"; then
        emit_json "$EXCEPTIONS_FILE" "$file" "$lineno" "$category" "$content"
      elif [ "$severity" = "blocker" ]; then
        emit_json "$BLOCKERS_FILE" "$file" "$lineno" "$category" "$content"
      else
        emit_json "$WARNINGS_FILE" "$file" "$lineno" "$category" "$content"
      fi
      break
    fi
  done
done < "$BUFFER_FILE"

# Assemble final JSON via jq slurping the line-delimited JSON files.
jq -n \
  --slurpfile blockers "$BLOCKERS_FILE" \
  --slurpfile warnings "$WARNINGS_FILE" \
  --slurpfile exceptions "$EXCEPTIONS_FILE" \
  '{blockers: $blockers, warnings: $warnings, exceptions: $exceptions}' > "$REPORT"

BLOCKER_COUNT=$(jq '.blockers | length' "$REPORT")
WARNING_COUNT=$(jq '.warnings | length' "$REPORT")
EXCEPTION_COUNT=$(jq '.exceptions | length' "$REPORT")

echo "Tech debt scan: $BLOCKER_COUNT blockers, $WARNING_COUNT warnings, $EXCEPTION_COUNT justified exceptions"

if [ "$BLOCKER_COUNT" -gt 0 ]; then
  echo "::error::$BLOCKER_COUNT tech debt blocker(s) found. See $REPORT or use '// reason: ...' to justify."
  jq -r '.blockers[] | "- \(.file):\(.line) [\(.category)] \(.content)"' "$REPORT"
  exit 1
fi
exit 0
