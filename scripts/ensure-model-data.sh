#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! npm --prefix packages/ai run --silent check:model-data >/dev/null 2>&1; then
    echo "Generated model data is missing or stale; hydrating from upstream catalogs..."
    npm --prefix packages/ai run hydrate-model-data
fi
