#!/usr/bin/env bash
# Annotate Tool - Copyright (C) 2026 Mark Van de Velde
# SPDX-License-Identifier: GPL-3.0-only
# Runs every harness headlessly and reports the totals.
#
# Harnesses report into a div called "checks" or, in parse-check, "out".
# --allow-file-access-from-files is required: several harnesses fetch() their
# sources, which a file:// page cannot do without it. Without the flag they
# fail with "Failed to fetch" - which is a harness fault, not a code fault, and
# has been mistaken for a pass before now when the output was grepped loosely.
set -u

CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

for f in "$DIR"/*.html; do
  name="$(basename "$f" .html)"
  # Not harnesses: loaded BY one.
  case "$name" in frame-child) continue;; esac

  tmp="$(mktemp -d)"
  out="$("$CHROME" --headless=new --disable-gpu --no-sandbox \
      --allow-file-access-from-files --virtual-time-budget=10000 \
      --user-data-dir="$tmp" --dump-dom "file:///$(cygpath -m "$f")" 2>/dev/null \
    | awk '/id="checks"|id="out"/{f=1} f{print; if (/<\/div>/) exit}' \
    | sed 's|</div>.*||')"
  rm -rf "$tmp"

  pass=$(printf '%s' "$out" | grep -o 'PASS' | wc -l | tr -d ' ')
  fail=$(printf '%s' "$out" | grep -o 'FAIL' | wc -l | tr -d ' ')
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))

  if [ "$fail" -gt 0 ]; then
    FAILED_FILES+=("$name")
    printf '%-22s %3d pass  %3d FAIL\n' "$name" "$pass" "$fail"
    printf '%s\n' "$out" | grep -o 'FAIL[^<]*' | sed 's/^/    /'
  elif [ "$pass" -eq 0 ]; then
    # A harness that reports nothing is broken, not clean. This has bitten
    # before: a stale test produced no checks at all and read as a pass.
    FAILED_FILES+=("$name (no checks ran)")
    printf '%-22s   0 pass  -- NO CHECKS RAN\n' "$name"
  else
    printf '%-22s %3d pass\n' "$name" "$pass"
  fi
done

echo "----------------------------------------"
echo "total: $TOTAL_PASS passed, $TOTAL_FAIL failed"
if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo "problem harnesses: ${FAILED_FILES[*]}"
  exit 1
fi
