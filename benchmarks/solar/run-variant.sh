#!/usr/bin/env bash
# usage: run-variant.sh <label> <artifact-path> [extra forge test args]
set -uo pipefail
label="$1"; artifact="$2"; shift 2
mkdir -p benchmarks/solar/results/"$label"
ROUTER_ARTIFACT="$artifact" forge test "$@" > benchmarks/solar/results/"$label"/test.log 2>&1
echo "exit=$?" >> benchmarks/solar/results/"$label"/test.log
cp snapshots/*.json benchmarks/solar/results/"$label"/
grep -E "^Suite result|^\[FAIL|exit=|succeeded of|routes over" benchmarks/solar/results/"$label"/test.log
git checkout -q snapshots
