import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

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
import {
  resolveRuntimeEntrypoint,
  verifyPackedPackage,
} from "./verify-packed-package.mjs";

const execFileAsync = promisify(execFile);

const ROUTER = "0x00000000D542a1Afa7A01ECB16254F7A0F8ceB61";
const OTHER_ROUTER = "0x1111111111111111111111111111111111111111";
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
  "opt-mainnet",
  "opt-sepolia",
  "bnb-mainnet",
  "gnosis-mainnet",
  "unichain-mainnet",
  "unichain-sepolia",
  "polygon-mainnet",
  "polygon-amoy",
  "monad-mainnet",
  "worldchain-mainnet",
  "worldchain-sepolia",
  "megaeth-mainnet",
  "megaeth-testnet",
  "ink-mainnet",
  "ink-sepolia",
  "eth-hoodi",
  "zksync-sepolia",
  "abstract-testnet",
];

function deployment(network, chainId, overrides = {}) {
  return {
    network,
    chainId,
    router: ROUTER,
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

test("release publishing uses npm trusted publishing without a token", async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../sdk/package.json", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /npm install --global npm@11\.18\.0/);
  assert.match(workflow, /npm publish/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.equal(
    JSON.parse(packageJson).repository.url,
    "git+https://github.com/EkuboProtocol/yul-router.git",
  );
});

test("deployment trusts a successful Forge script without reading router code afterward", async () => {
  const script = await readFile(
    new URL("./deploy-router.sh", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(script, /cast code "\$returned_router"/);
  assert.doesNotMatch(script, /no runtime code .* after deployment/);
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

test("SDK-only releases record preexisting routers without a raw broadcast", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "yul-router-release-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const networksFile = path.join(rootDir, "networks.txt");
  const releaseDir = path.join(
    rootDir,
    "broadcast",
    "releases",
    "v0.5.1",
  );
  await mkdir(releaseDir, { recursive: true });
  await writeFile(networksFile, "eth-mainnet\nbase-mainnet\n");
  await Promise.all([
    writeFile(
      path.join(releaseDir, "eth-mainnet.deployment.json"),
      JSON.stringify(deployment("eth-mainnet", "1")),
    ),
    writeFile(
      path.join(releaseDir, "base-mainnet.deployment.json"),
      JSON.stringify(deployment("base-mainnet", "8453")),
    ),
  ]);

  const manifest = await verifyReleaseDeployments("0.5.1", {
    rootDir,
    networksFile,
  });

  assert.equal(manifest.router, ROUTER);
  assert.deepEqual(
    manifest.deployments.map(
      ({ network, deployedNow, foundryBroadcast, transactionHashes }) => ({
        network,
        deployedNow,
        foundryBroadcast,
        transactionHashes,
      }),
    ),
    [
      {
        network: "eth-mainnet",
        deployedNow: false,
        foundryBroadcast: null,
        transactionHashes: [],
      },
      {
        network: "base-mainnet",
        deployedNow: false,
        foundryBroadcast: null,
        transactionHashes: [],
      },
    ],
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(releaseDir, "manifest.json"), "utf8"),
    ).router,
    ROUTER,
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

/**
 * A release checkout with the v0.7.0 and v0.8.0 manifests the release flow
 * writes, plus an empty sdk/node_modules for the packed entrypoint to resolve
 * against.
 */
async function packedPackageFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "yul-router-packed-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const networks = ["eth-mainnet", "base-mainnet"];
  const networksFile = path.join(rootDir, "networks.txt");
  await writeFile(networksFile, `${networks.join("\n")}\n`);
  await mkdir(path.join(rootDir, "sdk", "node_modules"), { recursive: true });

  const manifestFor = (version, router) => ({
    version,
    router,
    deployments: [
      deployment("eth-mainnet", "1", { router }),
      deployment("base-mainnet", "8453", { router }),
    ],
  });
  for (const [version, router] of [
    ["0.7.0", OTHER_ROUTER],
    ["0.8.0", ROUTER],
  ]) {
    const releaseDir = path.join(rootDir, "broadcast", "releases", `v${version}`);
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      path.join(releaseDir, "manifest.json"),
      JSON.stringify(manifestFor(version, router)),
    );
  }
  await writeFile(
    path.join(rootDir, "broadcast", "deployments.json"),
    JSON.stringify(manifestFor("0.8.0", ROUTER)),
  );

  let counter = 0;
  const pack = async ({
    version = "0.8.0",
    entrySource = `export const YUL_ROUTER_ADDRESS = "${ROUTER}";\n`,
    entryName = "dist/index.js",
    extraFiles = {},
  } = {}) => {
    const stageDir = path.join(rootDir, `stage-${counter}`);
    const tarballPath = path.join(rootDir, `package-${counter}.tgz`);
    counter += 1;
    const packageDir = path.join(stageDir, "package");
    await mkdir(path.join(packageDir, "dist"), { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@ekubo/yul-router-sdk",
        version,
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    await writeFile(path.join(packageDir, "README.md"), "# fixture\n");
    await writeFile(path.join(packageDir, entryName), entrySource);
    for (const [name, contents] of Object.entries(extraFiles)) {
      await writeFile(path.join(packageDir, name), contents);
    }
    await execFileAsync("tar", ["-czf", tarballPath, "-C", stageDir, "package"]);
    return tarballPath;
  };

  const verify = (tarballPath, version = "0.8.0") =>
    verifyPackedPackage(version, tarballPath, { rootDir, networksFile });

  return { rootDir, pack, verify };
}

test("packed package verification resolves the runtime entrypoint from package.json", () => {
  assert.equal(
    resolveRuntimeEntrypoint({
      name: "@ekubo/yul-router-sdk",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }),
    "dist/index.js",
  );
  assert.equal(
    resolveRuntimeEntrypoint({ name: "@ekubo/yul-router-sdk", main: "./dist/index.cjs" }),
    "dist/index.cjs",
  );
  assert.throws(
    () => resolveRuntimeEntrypoint({ name: "@ekubo/other", main: "./dist/index.js" }),
    /unexpected package name/,
  );
  assert.throws(
    () => resolveRuntimeEntrypoint({ name: "@ekubo/yul-router-sdk" }),
    /runtime entrypoint/,
  );
});

test("packed package verification accepts the artifact that targets the verified release router", async (t) => {
  const { pack, verify } = await packedPackageFixture(t);

  const result = await verify(await pack());

  assert.equal(result.package, "@ekubo/yul-router-sdk@0.8.0");
  assert.equal(result.entrypoint, "dist/index.js");
  assert.equal(result.router, ROUTER);
  assert.equal(result.version, "0.8.0");
  assert.deepEqual(result.chainIds, ["1", "8453"]);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("packed package verification names a router left over from an earlier release as stale", async (t) => {
  const { pack, verify } = await packedPackageFixture(t);

  await assert.rejects(
    verify(
      await pack({
        entrySource: `export const YUL_ROUTER_ADDRESS = "${OTHER_ROUTER}";\n`,
      }),
    ),
    /stale router address .* router of v0\.7\.0, but v0\.8\.0 is deployed at/,
  );
});

test("packed package verification rejects an address no release ever deployed", async (t) => {
  const { pack, verify } = await packedPackageFixture(t);
  const neverDeployed = "0x2222222222222222222222222222222222222222";

  await assert.rejects(
    verify(
      await pack({
        entrySource: `export const YUL_ROUTER_ADDRESS = "${neverDeployed}";\n`,
      }),
    ),
    /unknown router address 0x2222/,
  );
});

test("packed package verification loads the entrypoint rather than trusting a text scan", async (t) => {
  const { pack, verify } = await packedPackageFixture(t);
  const head = OTHER_ROUTER.slice(0, 22);
  const tail = OTHER_ROUTER.slice(22);

  await assert.rejects(
    verify(
      await pack({
        entrySource: `export const YUL_ROUTER_ADDRESS = "${head}" + "${tail}";\n`,
      }),
    ),
    /exports stale router address/,
  );
  await assert.rejects(
    verify(await pack({ entrySource: "export const OTHER = 1;\n" })),
    /does not export a valid YUL_ROUTER_ADDRESS/,
  );
});

test("packed package verification rejects version drift between tarball, release and manifests", async (t) => {
  const { rootDir, pack, verify } = await packedPackageFixture(t);

  await assert.rejects(
    verify(await pack({ version: "0.8.1" })),
    /packed package\.json is version 0\.8\.1, expected 0\.8\.0/,
  );
  await assert.rejects(
    verify(await pack({ version: "0.9.0" }), "0.9.0"),
    /no verified deployment manifest for v0\.9\.0/,
  );

  // The release flow writes broadcast/deployments.json from the same manifest;
  // a checkout where they disagree must not publish.
  await writeFile(
    path.join(rootDir, "broadcast", "deployments.json"),
    JSON.stringify({ version: "0.7.0", router: OTHER_ROUTER, deployments: [] }),
  );
  await assert.rejects(
    verify(await pack()),
    /broadcast\/deployments\.json records v0\.7\.0/,
  );
});

test("packed package verification rejects tarballs with leaked or missing files", async (t) => {
  const { pack, verify } = await packedPackageFixture(t);

  await assert.rejects(
    verify(await pack({ extraFiles: { ".env": "SECRET=1\n" } })),
    /unexpected files: package\/\.env/,
  );
  await assert.rejects(
    verify(await pack({ entryName: "dist/index.mjs" })),
    /runtime entrypoint dist\/index\.js is not in the tarball/,
  );
});

test("packed package verification reuses the all-chain deployment check on the manifest", async (t) => {
  const { rootDir, pack, verify } = await packedPackageFixture(t);
  const manifestPath = path.join(rootDir, "broadcast", "releases", "v0.8.0", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  manifest.deployments.pop();
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verify(await pack()),
    /expected 2 deployment records, found 1/,
  );
});
