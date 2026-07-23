import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseNetworks,
  verifyDeploymentRecords,
  verifyReleaseDeployments,
} from "./verify-deployments.mjs";
import {
  updatePackageJson,
  updateRouterAddress,
  validateVersion,
} from "./prepare-package.mjs";

const ROUTER = "0x00000000D542a1Afa7A01ECB16254F7A0F8ceB61";
const OTHER_ROUTER = "0x1111111111111111111111111111111111111111";
const CODE_HASH = `0x${"22".repeat(32)}`;
const TRANSACTION_HASH = `0x${"33".repeat(32)}`;
const DEFAULT_NETWORKS = [
  "eth-mainnet",
  "eth-sepolia",
  "robinhood-mainnet",
  "robinhood-testnet",
  "base-mainnet",
  "base-sepolia",
  "arb-mainnet",
  "arb-sepolia",
];

function deployment(network, chainId, overrides = {}) {
  return {
    network,
    chainId,
    router: ROUTER,
    runtimeCodeHash: CODE_HASH,
    deployedNow: false,
    transactionHashes: [],
    foundryBroadcast: null,
    ...overrides,
  };
}

test("network configuration accepts one Alchemy prefix per line", () => {
  assert.deepEqual(
    parseNetworks(`
      # comment
      eth-mainnet
      base-sepolia # inline comment
    `),
    ["eth-mainnet", "base-sepolia"],
  );
  assert.throws(
    () => parseNetworks("eth-mainnet\neth-mainnet\n"),
    /duplicates/,
  );
  assert.throws(() => parseNetworks("https:\/\/example.com"), /invalid/);
});

test("default release configuration covers every supported deployment", async () => {
  assert.deepEqual(
    parseNetworks(
      await readFile(
        new URL("./alchemy-networks.txt", import.meta.url),
        "utf8",
      ),
    ),
    DEFAULT_NETWORKS,
  );
});

test("deployment verification returns one shared router address", () => {
  const verified = verifyDeploymentRecords(
    ["eth-mainnet", "base-sepolia"],
    [
      deployment("base-sepolia", "84532"),
      deployment("eth-mainnet", "1"),
    ],
  );

  assert.equal(verified.router, ROUTER);
  assert.deepEqual(
    verified.deployments.map(({ network }) => network),
    ["eth-mainnet", "base-sepolia"],
  );
});

test("deployment verification rejects missing or mismatched chains", () => {
  assert.throws(
    () =>
      verifyDeploymentRecords(
        ["eth-mainnet", "base-sepolia"],
        [deployment("eth-mainnet", "1")],
      ),
    /expected 2 deployment records/,
  );
  assert.throws(
    () =>
      verifyDeploymentRecords(
        ["eth-mainnet", "base-sepolia"],
        [
          deployment("eth-mainnet", "1"),
          deployment("base-sepolia", "84532", { router: OTHER_ROUTER }),
        ],
      ),
    /router address mismatch/,
  );
  assert.throws(
    () =>
      verifyDeploymentRecords(
        ["eth-mainnet", "base-sepolia"],
        [
          deployment("eth-mainnet", "1"),
          deployment("base-sepolia", "84532", {
            runtimeCodeHash: `0x${"33".repeat(32)}`,
          }),
        ],
      ),
    /runtime code hash mismatch/,
  );
});

test("release verification checks raw Foundry broadcasts before writing manifests", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "yul-router-release-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const networksFile = path.join(rootDir, "networks.txt");
  const releaseDir = path.join(
    rootDir,
    "broadcast",
    "releases",
    "v0.5.0",
  );
  const foundryPath = path.join(releaseDir, "eth-mainnet.foundry.json");
  const foundryRelativePath = path.relative(rootDir, foundryPath);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(networksFile, "eth-mainnet\n");
  await writeFile(
    foundryPath,
    JSON.stringify({
      chain: 1,
      returns: { router: { value: ROUTER } },
      transactions: [{ hash: TRANSACTION_HASH }],
    }),
  );
  await writeFile(
    path.join(releaseDir, "eth-mainnet.deployment.json"),
    JSON.stringify(
      deployment("eth-mainnet", "1", {
        deployedNow: true,
        transactionHashes: [TRANSACTION_HASH],
        foundryBroadcast: foundryRelativePath,
      }),
    ),
  );

  const manifest = await verifyReleaseDeployments("0.5.0", {
    rootDir,
    networksFile,
  });
  assert.equal(manifest.router, ROUTER);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(rootDir, "broadcast", "deployments.json"),
        "utf8",
      ),
    ).router,
    ROUTER,
  );

  await writeFile(
    foundryPath,
    JSON.stringify({
      chain: 1,
      returns: { router: { value: OTHER_ROUTER } },
      transactions: [{ hash: TRANSACTION_HASH }],
    }),
  );
  await assert.rejects(
    verifyReleaseDeployments("0.5.0", { rootDir, networksFile }),
    /raw Foundry broadcast router does not match/,
  );
});

test("package preparation validates the version and router declaration", () => {
  assert.equal(validateVersion("1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => validateVersion("v1.2.3"), /semantic version/);

  const packageJson = updatePackageJson(
    JSON.stringify({ name: "@ekubo/yul-router-sdk", version: "0.4.0" }),
    "0.5.0",
  );
  assert.equal(JSON.parse(packageJson).version, "0.5.0");

  const source = updateRouterAddress(
    `export const YUL_ROUTER_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";
`,
    ROUTER,
  );
  assert.match(source, new RegExp(ROUTER));
  assert.throws(
    () => updateRouterAddress("export const other = 1;", ROUTER),
    /expected one YUL_ROUTER_ADDRESS/,
  );
});
