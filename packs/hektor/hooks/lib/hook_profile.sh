#!/bin/bash
# hook_profile.sh — one dial to select which gates run, instead of N env switches.
#
# Port of ECC scripts/lib/hook-flags.js (ECC_HOOK_PROFILE / ECC_DISABLED_HOOKS).
# Each gate declares the profiles it runs in; a central dial picks the tier.
#
#   HEKTOR_HOOK_PROFILE = minimal | standard(default) | strict
#     minimal  — hard blockers only (commit, destructive, invisible-unicode, pr-rules).
#                Good for CI / batch runs where the human-nag gates are noise.
#     standard — + capture + the schema/journey gates (the default).
#     strict   — + the full reviewer-attestation nag cluster + delivery Stop-gate.
#   HEKTOR_DISABLED_HOOKS = csv of gate ids to force-off (e.g. "delivery-gate,observe").
#
# Usage in a gate (after sourcing this):
#   hektor_hook_enabled <gate-id> "<profiles-csv>" || exit 0
# Fail-open: an unknown profile value falls back to `standard`.
hektor_hook_enabled() {
  local id="$1" profiles="${2:-minimal,standard,strict}" prof
  case ",${HEKTOR_DISABLED_HOOKS:-}," in *",${id},"*) return 1 ;; esac
  prof="$(printf '%s' "${HEKTOR_HOOK_PROFILE:-standard}" | tr '[:upper:]' '[:lower:]')"
  case "$prof" in minimal|standard|strict) ;; *) prof="standard" ;; esac
  case ",${profiles}," in *",${prof},"*) return 0 ;; *) return 1 ;; esac
}
