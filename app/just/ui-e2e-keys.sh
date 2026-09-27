#!/usr/bin/env bash
# #33 AC2 keyboard-only proof: the same harness as ui-e2e.sh (real gated
# server on a fresh mktemp dataset, CLI seed, ego-browser, EXIT-trap
# teardown that clears the origin's storage and removes the root), running
# ONLY the keyboard segment (ui-e2e/keys.mjs): Tab, Shift+Tab, arrows,
# Home/End, Enter, Space and typing -- no DOM .click, no value setters.
#
#   bash app/just/ui-e2e-keys.sh [OUT_DIR]
#
# Verdicts are the usual STEP_OK / STEP_FAIL / STEP_SKIP lines; exit 1 on any
# STEP_FAIL. Set UI_E2E_NO_BUILD=1 to test the committed bundle as is.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_E2E_SEGMENT=keys UI_E2E_DRIVER_BUDGET="${UI_E2E_DRIVER_BUDGET:-360}" exec bash "$HERE/ui-e2e.sh" "$@"
