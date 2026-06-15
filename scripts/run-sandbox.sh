#!/usr/bin/env bash
set -euo pipefail

echo "=== Building project ==="
pnpm build

echo "=== Running nuage-agent runner (once) ==="
pnpm dev:runner --once -- --repo-map-dir ./repo-map/sandbox
