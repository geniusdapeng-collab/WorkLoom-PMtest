#!/usr/bin/env bash
set -euo pipefail

# Historical upstream deployment. PMtest has no authorized Linux target.
printf '%s\n' 'WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.' >&2
exit 78

release_root="${WORKLOOM_RELEASE_ROOT:-/opt/workloom-pm/current}"
node_bin="${WORKLOOM_NODE_BIN:-/opt/workloom-pm/runtime/current/bin/node}"

if [[ ! -x "$node_bin" ]]; then
  printf 'WorkLoom Node runtime is missing: %s\n' "$node_bin" >&2
  exit 1
fi
if [[ ! -f "$release_root/node_modules/tsx/dist/cli.mjs" ]]; then
  printf 'WorkLoom release dependencies are incomplete: %s\n' "$release_root" >&2
  exit 1
fi

cd "$release_root"
exec "$node_bin" node_modules/tsx/dist/cli.mjs apps/server/src/index.ts
