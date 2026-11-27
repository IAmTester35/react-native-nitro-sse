#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ANDROID_LINT_STATUS="SKIP"
DETEKT_STATUS="SKIP"
SWIFTLINT_STATUS="SKIP"
PERIPHERY_STATUS="SKIP"
EXIT_CODE=0

run_step() {
  local label="$1"
  shift
  echo ""
  echo "============================================================"
  echo "▶ $label"
  echo "============================================================"
  "$@"
  return $?
}

# 1. Android Lint (Gradle)
if [[ -x "$ROOT_DIR/example/android/gradlew" ]]; then
  if run_step "[1/4] Android Lint (:react-native-nitro-sse:lintDebug)" \
    bash -c "cd \"$ROOT_DIR/example/android\" && ./gradlew :react-native-nitro-sse:lintDebug"; then
    ANDROID_LINT_STATUS="PASS (report: android/build/reports/lint-results-debug.html)"
  else
    ANDROID_LINT_STATUS="FAIL"
    EXIT_CODE=1
  fi
else
  echo "⚠️  example/android/gradlew not found; skipping Android Lint."
fi

# 2. Kotlin Detekt
if command -v detekt >/dev/null 2>&1; then
  if run_step "[2/4] Kotlin Detekt (android/src/main/java)" \
    detekt --input "$ROOT_DIR/android/src/main/java"; then
    DETEKT_STATUS="PASS"
  else
    DETEKT_STATUS="FAIL"
    EXIT_CODE=1
  fi
else
  echo "⚠️  detekt not installed (install: brew install detekt)."
  DETEKT_STATUS="MISSING"
fi

# 3. SwiftLint
if command -v swiftlint >/dev/null 2>&1; then
  shopt -s nullglob
  SWIFT_FILES=("$ROOT_DIR"/ios/*.swift)
  shopt -u nullglob
  if [[ ${#SWIFT_FILES[@]} -gt 0 ]]; then
    if run_step "[3/4] SwiftLint (ios/*.swift)" \
      swiftlint lint "${SWIFT_FILES[@]}"; then
      SWIFTLINT_STATUS="PASS"
    else
      SWIFTLINT_STATUS="FAIL"
      EXIT_CODE=1
    fi
  fi
else
  echo "⚠️  swiftlint not installed (install: brew install swiftlint)."
  SWIFTLINT_STATUS="MISSING"
fi

# 4. Swift Dead Code (Periphery)
if command -v periphery >/dev/null 2>&1; then
  if run_step "[4/4] Swift Dead Code (Periphery)" \
    periphery scan \
      --project "$ROOT_DIR/example/ios/NitroSseExample.xcworkspace" \
      --schemes NitroSse-Unit-Tests \
      --retain-public \
      --report-include "ios/*.swift"; then
    PERIPHERY_STATUS="PASS"
  else
    PERIPHERY_STATUS="FAIL"
    EXIT_CODE=1
  fi
else
  echo "⚠️  periphery not installed (install: brew install periphery)."
  PERIPHERY_STATUS="MISSING"
fi

echo ""
echo "============================================================"
echo "Native Check Summary"
echo "------------------------------------------------------------"
echo "  1. Android Lint : $ANDROID_LINT_STATUS"
echo "  2. Detekt       : $DETEKT_STATUS"
echo "  3. SwiftLint    : $SWIFTLINT_STATUS"
echo "  4. Periphery    : $PERIPHERY_STATUS"
echo "============================================================"

exit "$EXIT_CODE"
