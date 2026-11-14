#!/usr/bin/env bash
# usage: build-solar.sh <solar-binary> <out-name> [extra solar flags...]
set -euo pipefail
solar="$1"; name="$2"; shift 2
mkdir -p "out/$name"
"$solar" src/YulRouter.sol --emit bin,bin-runtime --evm-version osaka "$@" 2>/dev/null > "out/$name/combined.json"
jq '{bytecode:{object:("0x"+.contracts["src/YulRouter.sol:YulRouter"].bin)},deployedBytecode:{object:("0x"+.contracts["src/YulRouter.sol:YulRouter"]["bin-runtime"])},version}' "out/$name/combined.json" > "out/$name/YulRouter.json"
jq -r '"\(.version) runtime_bytes=\((.deployedBytecode.object|length-2)/2) init_bytes=\((.bytecode.object|length-2)/2)"' "out/$name/YulRouter.json"
