#!/usr/bin/env sh

# Client-aware config-dir resolution, mirroring src/utils/client.ts priority
# (keep semantics in sync — enforced by src/__tests__/client-config-dir-mirrors.test.ts):
#   1. OMC_CLIENT=codebuddy → ~/.codebuddy; OMC_CLIENT=zcode → ~/.zcode;
#      OMC_CLIENT=claude suppresses both session signatures and keeps
#      CLAUDE_CONFIG_DIR/~/.claude (other values fall through to auto-detection)
#   2. CodeBuddy session signature (any of CODEBUDDY_PLUGIN_ROOT /
#      CODEBUDDY_PLUGIN_DIRS / CODEBUDDY_PLUGIN_DATA set) → ~/.codebuddy
#   3. ZCode session signature (any of ZCODE_APP_VERSION / ZCODE_PLUGIN_ROOT /
#      ZCODE_PLUGIN_DATA set) → ~/.zcode
#   4. CLAUDE_CONFIG_DIR (absolute or ~-prefixed) is honoured
#   5. fallback ~/.claude
# Shell capability boundary: plain existence checks only — values must be
# clean (no leading/trailing whitespace); OMC_CLIENT must be exact lowercase.

resolve_claude_config_dir() {
  omc_client="${OMC_CLIENT:-}"
  omc_is_codebuddy=0
  if [ "$omc_client" = "codebuddy" ]; then
    omc_is_codebuddy=1
  elif [ "$omc_client" != "claude" ] &&
    { [ -n "${CODEBUDDY_PLUGIN_ROOT:-}" ] ||
      [ -n "${CODEBUDDY_PLUGIN_DIRS:-}" ] ||
      [ -n "${CODEBUDDY_PLUGIN_DATA:-}" ]; }; then
    omc_is_codebuddy=1
  fi
  omc_is_zcode=0
  if [ "$omc_client" = "zcode" ]; then
    omc_is_zcode=1
  elif [ "$omc_client" != "claude" ] && [ "$omc_is_codebuddy" != "1" ] &&
    { [ -n "${ZCODE_APP_VERSION:-}" ] ||
      [ -n "${ZCODE_PLUGIN_ROOT:-}" ] ||
      [ -n "${ZCODE_PLUGIN_DATA:-}" ]; }; then
    omc_is_zcode=1
  fi
  if [ "$omc_is_zcode" = "1" ]; then
    configured="$HOME/.zcode"
  elif [ "$omc_is_codebuddy" = "1" ]; then
    configured="$HOME/.codebuddy"
  else
    configured="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  fi
  # Strip trailing separators (all of them) while preserving the filesystem
  # root — mirrors stripTrailingSep + normalize in src/utils/client.ts.
  while [ "$configured" != "/" ] && [ "${configured%/}" != "$configured" ]; do
    configured="${configured%/}"
  done
  case "$configured" in
    \~)
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      configured="${configured#\~/}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    *)
      printf '%s\n' "$configured"
      ;;
  esac
}
