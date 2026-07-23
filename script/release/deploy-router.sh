#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

RELEASE_VERSION="${1:-}"
NETWORKS_FILE="${ALCHEMY_NETWORKS_FILE:-script/release/alchemy-networks.txt}"
RPC_URL_TEMPLATE="${ALCHEMY_RPC_URL_TEMPLATE:-}"
if [[ -z "$RPC_URL_TEMPLATE" ]]; then
  RPC_URL_TEMPLATE='https://{network}.g.alchemy.com/v2/{key}'
fi
CANONICAL_CORE="0x00000000000014aA86C5d3c41765bb24e11bd701"
DETERMINISTIC_DEPLOYER="0x4e59b44847b379578588920cA78FbF26c0B4956C"

if [[ -z "$RELEASE_VERSION" || ! "$RELEASE_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  echo "usage: $0 <release-version>" >&2
  exit 1
fi
if [[ ! -f "$NETWORKS_FILE" ]]; then
  echo "networks file not found: $NETWORKS_FILE" >&2
  exit 1
fi
: "${ALCHEMY_API_KEY:?ALCHEMY_API_KEY is required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"

for command in cast forge jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 1
  fi
done

networks=()
while IFS= read -r line || [[ -n "$line" ]]; do
  network="${line%%#*}"
  network="${network#"${network%%[![:space:]]*}"}"
  network="${network%"${network##*[![:space:]]}"}"
  [[ -z "$network" ]] && continue
  if [[ ! "$network" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "invalid Alchemy network identifier: $network" >&2
    exit 1
  fi
  if [[ "${#networks[@]}" -gt 0 ]]; then
    for existing_network in "${networks[@]}"; do
      if [[ "$existing_network" == "$network" ]]; then
        echo "duplicate Alchemy network identifier: $network" >&2
        exit 1
      fi
    done
  fi
  networks+=("$network")
done < "$NETWORKS_FILE"

if [[ "${#networks[@]}" -eq 0 ]]; then
  echo "no Alchemy networks configured in $NETWORKS_FILE" >&2
  exit 1
fi

rpc_url_for() {
  local network="$1"
  local rpc_url="${RPC_URL_TEMPLATE//\{network\}/$network}"
  rpc_url="${rpc_url//\{key\}/$ALCHEMY_API_KEY}"
  printf '%s' "$rpc_url"
}

offline_output="$(forge script script/DeployYulRouter.s.sol --sig "run()" --offline)"
expected_routers=()
while IFS= read -r address; do
  [[ -n "$address" ]] && expected_routers+=("$address")
done < <(printf '%s\n' "$offline_output" | awk '$1 == "router:" && $2 == "address" { print $3 }')

if [[ "${#expected_routers[@]}" -ne 1 || ! "${expected_routers[0]}" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "could not determine one expected router address from DeployYulRouter" >&2
  exit 1
fi
expected_router="${expected_routers[0]}"
broadcaster="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"

chain_ids=()
router_preexisting=()
for network in "${networks[@]}"; do
  rpc_url="$(rpc_url_for "$network")"
  chain_id="$(cast chain-id --rpc-url "$rpc_url")"
  if [[ ! "$chain_id" =~ ^[0-9]+$ ]]; then
    echo "$network returned invalid chain id: $chain_id" >&2
    exit 1
  fi
  if [[ "${#chain_ids[@]}" -gt 0 ]]; then
    for existing_chain_id in "${chain_ids[@]}"; do
      if [[ "$existing_chain_id" == "$chain_id" ]]; then
        echo "multiple configured networks resolve to chain id $chain_id" >&2
        exit 1
      fi
    done
  fi

  core_code="$(cast code "$CANONICAL_CORE" --rpc-url "$rpc_url")"
  if [[ "$core_code" == "0x" ]]; then
    echo "$network ($chain_id) has no canonical Ekubo Core at $CANONICAL_CORE" >&2
    exit 1
  fi
  deterministic_deployer_code="$(cast code "$DETERMINISTIC_DEPLOYER" --rpc-url "$rpc_url")"
  if [[ "$deterministic_deployer_code" == "0x" ]]; then
    echo "$network ($chain_id) has no deterministic deployer at $DETERMINISTIC_DEPLOYER" >&2
    exit 1
  fi

  existing_router_code="$(cast code "$expected_router" --rpc-url "$rpc_url")"
  if [[ "$existing_router_code" == "0x" ]]; then
    broadcaster_balance="$(cast balance "$broadcaster" --rpc-url "$rpc_url")"
    if [[ "$broadcaster_balance" == "0" ]]; then
      echo "$broadcaster has no deployment funds on $network ($chain_id)" >&2
      exit 1
    fi
    router_preexisting+=("false")
  else
    router_preexisting+=("true")
  fi

  chain_ids+=("$chain_id")
  echo "preflight ok: $network (chain $chain_id)"
done

release_dir="broadcast/releases/v${RELEASE_VERSION}"
if [[ -e "$release_dir" ]]; then
  echo "release broadcast directory already exists: $release_dir" >&2
  exit 1
fi
mkdir -p "$release_dir"

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

for index in "${!networks[@]}"; do
  network="${networks[$index]}"
  chain_id="${chain_ids[$index]}"
  preexisting="${router_preexisting[$index]}"
  rpc_url="$(rpc_url_for "$network")"
  raw_broadcast="broadcast/DeployYulRouter.s.sol/${chain_id}/run-latest.json"
  deploy_output="$temp_dir/${network}.log"

  if [[ "$preexisting" == "false" ]]; then
    rm -f "$raw_broadcast"
  fi

  echo "deploying: $network (chain $chain_id)"
  set +e
  forge script script/DeployYulRouter.s.sol \
    --sig "run()" \
    --rpc-url "$rpc_url" \
    --broadcast \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --non-interactive \
    --slow \
    -vv 2>&1 | tee "$deploy_output"
  forge_status="${PIPESTATUS[0]}"
  set -e
  if [[ "$forge_status" -ne 0 ]]; then
    echo "DeployYulRouter failed on $network (chain $chain_id)" >&2
    exit "$forge_status"
  fi

  returned_routers=()
  while IFS= read -r address; do
    [[ -n "$address" ]] && returned_routers+=("$address")
  done < <(awk '$1 == "router:" && $2 == "address" { print $3 }' "$deploy_output")
  if [[ "${#returned_routers[@]}" -ne 1 ]]; then
    echo "DeployYulRouter did not return one router on $network" >&2
    exit 1
  fi
  returned_router="${returned_routers[0]}"
  returned_router_normalized="$(printf '%s' "$returned_router" | tr '[:upper:]' '[:lower:]')"
  expected_router_normalized="$(printf '%s' "$expected_router" | tr '[:upper:]' '[:lower:]')"
  if [[ "$returned_router_normalized" != "$expected_router_normalized" ]]; then
    echo "$network returned $returned_router, expected $expected_router" >&2
    exit 1
  fi

  transaction_hashes="[]"
  versioned_foundry_broadcast=""
  if [[ "$preexisting" == "false" ]]; then
    if [[ ! -f "$raw_broadcast" ]]; then
      echo "Foundry did not write $raw_broadcast for $network" >&2
      exit 1
    fi
    broadcast_router="$(jq -r '.returns.router.value // empty' "$raw_broadcast")"
    broadcast_router_normalized="$(printf '%s' "$broadcast_router" | tr '[:upper:]' '[:lower:]')"
    if [[ "$broadcast_router_normalized" != "$returned_router_normalized" ]]; then
      echo "$network broadcast returned $broadcast_router, script returned $returned_router" >&2
      exit 1
    fi
    versioned_foundry_broadcast="${release_dir}/${network}.foundry.json"
    cp "$raw_broadcast" "$versioned_foundry_broadcast"
    transaction_hashes="$(jq -c '[.transactions[].hash]' "$raw_broadcast")"
  fi

  router_code="$(cast code "$returned_router" --rpc-url "$rpc_url")"
  if [[ "$router_code" == "0x" ]]; then
    echo "$network has no runtime code at $returned_router after deployment" >&2
    exit 1
  fi
  runtime_code_hash="$(cast keccak "$router_code")"
  block_number="$(cast block-number --rpc-url "$rpc_url")"
  verified_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  jq -n \
    --arg network "$network" \
    --arg chainId "$chain_id" \
    --arg router "$returned_router" \
    --arg canonicalCore "$CANONICAL_CORE" \
    --arg deterministicDeployer "$DETERMINISTIC_DEPLOYER" \
    --arg broadcaster "$broadcaster" \
    --arg runtimeCodeHash "$runtime_code_hash" \
    --arg blockNumber "$block_number" \
    --arg verifiedAt "$verified_at" \
    --arg foundryBroadcast "$versioned_foundry_broadcast" \
    --argjson deployedNow "$([[ "$preexisting" == "false" ]] && printf true || printf false)" \
    --argjson transactionHashes "$transaction_hashes" \
    '{
      network: $network,
      chainId: $chainId,
      router: $router,
      canonicalCore: $canonicalCore,
      deterministicDeployer: $deterministicDeployer,
      broadcaster: $broadcaster,
      runtimeCodeHash: $runtimeCodeHash,
      blockNumber: $blockNumber,
      verifiedAt: $verifiedAt,
      deployedNow: $deployedNow,
      transactionHashes: $transactionHashes,
      foundryBroadcast: (
        if $foundryBroadcast == "" then null else $foundryBroadcast end
      )
    }' > "${release_dir}/${network}.deployment.json"
done

echo "deployment records written to $release_dir"
