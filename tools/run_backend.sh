#!/usr/bin/env bash
# Run the backend with a loader path that actually works on this NixOS laptop
# (README §8.5: PyPI wheels want libstdc++.so.6 / libz.so.1, which are not on the
# default loader path here). On any other machine this script is a plain
# pass-through to the venv python, so there is one documented way to start.
#
#   tools/run_backend.sh --profile laptop_dmic
#   tools/run_backend.sh --source udp
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
py="$repo/.venv/bin/python"

if [[ ! -x "$py" ]]; then
  echo "no venv at $repo/.venv — run: uv venv .venv && uv pip install -r requirements.txt" >&2
  exit 1
fi

# Prepend the store paths only when the loader would otherwise fail, so the
# script stays honest about what it is doing.
probe() { "$py" -c 'import ai_edge_litert' >/dev/null 2>&1; }
if ! probe; then
  libs=""
  for name in libstdc++.so.6 libz.so.1; do
    p="$(ldconfig -p 2>/dev/null | awk -v n="$name" '$1==n {print $NF; exit}')"
    [[ -z "$p" ]] && p="$(find /nix/store -maxdepth 4 -name "$name" -printf '%h\n' 2>/dev/null | head -1)"
    [[ -n "$p" ]] && libs="$libs:$p"
  done
  if [[ -n "$libs" ]]; then
    export LD_LIBRARY_PATH="${libs#:}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    echo "run_backend: added loader paths for $libs" >&2
  fi
fi

cd "$repo"
exec "$py" -m server.main "$@"
