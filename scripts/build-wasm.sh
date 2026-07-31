#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compiler="${EMXX:-em++}"

if ! command -v "$compiler" >/dev/null 2>&1; then
  echo "em++ was not found. Install and activate Emscripten, then rerun npm run build:wasm." >&2
  exit 1
fi

"$compiler" "$repo_dir/src/client.cpp" \
  --bind \
  -std=c++20 \
  -O3 \
  -flto \
  -Wall \
  -Wextra \
  -Wpedantic \
  -Werror \
  -sALLOW_MEMORY_GROWTH=1 \
  -sDYNAMIC_EXECUTION=0 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=1 \
  -sFILESYSTEM=0 \
  -sMALLOC=emmalloc \
  -sMODULARIZE=1 \
  -sNO_EXIT_RUNTIME=1 \
  -o "$repo_dir/public/voicechat-runtime.js"

echo "Built public/voicechat-runtime.js and public/voicechat-runtime.wasm"
