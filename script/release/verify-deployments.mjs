import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_NETWORKS_FILE = path.join(SCRIPT_DIR, "alchemy-networks.txt");
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function parseNetworks(contents) {
  const networks = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);

  if (networks.length === 0) {
    throw new Error("no release networks configured");
  }
  if (new Set(networks).size !== networks.length) {
    throw new Error("release networks contain duplicates");
  }
  for (const network of networks) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(network)) {
      throw new Error(`invalid Alchemy network identifier: ${network}`);
    }
  }
  return networks;
}

export function verifyDeploymentRecords(networks, records) {
  if (records.length !== networks.length) {
    throw new Error(
      `expected ${networks.length} deployment records, found ${records.length}`,
    );
  }

  const recordsByNetwork = new Map();
  const seenChainIds = new Set();
  let router;
  let runtimeCodeHash;

  for (const record of records) {
    if (!record || typeof record !== "object") {
      throw new Error("invalid deployment record");
    }
    if (!networks.includes(record.network)) {
      throw new Error(`unexpected deployment network: ${record.network}`);
    }
    if (recordsByNetwork.has(record.network)) {
      throw new Error(`duplicate deployment record: ${record.network}`);
    }
    if (!/^[0-9]+$/.test(record.chainId)) {
      throw new Error(`${record.network} has invalid chain id`);
    }
    if (seenChainIds.has(record.chainId)) {
      throw new Error(`duplicate deployment chain id: ${record.chainId}`);
    }
    if (!ADDRESS_PATTERN.test(record.router)) {
      throw new Error(`${record.network} has invalid router address`);
    }
    if (!HASH_PATTERN.test(record.runtimeCodeHash)) {
      throw new Error(`${record.network} has invalid runtime code hash`);
    }
    if (typeof record.deployedNow !== "boolean") {
      throw new Error(`${record.network} has invalid deployedNow value`);
    }
    if (
      !Array.isArray(record.transactionHashes) ||
      record.transactionHashes.some((hash) => !HASH_PATTERN.test(hash))
    ) {
      throw new Error(`${record.network} has invalid transaction hashes`);
    }
    if (
      record.foundryBroadcast !== null &&
      typeof record.foundryBroadcast !== "string"
    ) {
      throw new Error(`${record.network} has invalid Foundry broadcast path`);
    }
    if (
      record.deployedNow &&
      (record.transactionHashes.length === 0 || !record.foundryBroadcast)
    ) {
      throw new Error(
        `${record.network} was deployed now but has no raw Foundry broadcast`,
      );
    }
    if (
      !record.deployedNow &&
      (record.transactionHashes.length !== 0 ||
        record.foundryBroadcast !== null)
    ) {
      throw new Error(
        `${record.network} was already deployed but claims a new broadcast`,
      );
    }

    if (router === undefined) {
      router = record.router;
    } else if (record.router.toLowerCase() !== router.toLowerCase()) {
      throw new Error(
        `router address mismatch: ${record.network} has ${record.router}, expected ${router}`,
      );
    }
    if (runtimeCodeHash === undefined) {
      runtimeCodeHash = record.runtimeCodeHash;
    } else if (
      record.runtimeCodeHash.toLowerCase() !== runtimeCodeHash.toLowerCase()
    ) {
      throw new Error(
        `runtime code hash mismatch on ${record.network}: ${record.runtimeCodeHash}`,
      );
    }

    recordsByNetwork.set(record.network, record);
    seenChainIds.add(record.chainId);
  }

  for (const network of networks) {
    if (!recordsByNetwork.has(network)) {
      throw new Error(`missing deployment record: ${network}`);
    }
  }

  return {
    router,
    runtimeCodeHash,
    deployments: networks.map((network) => recordsByNetwork.get(network)),
  };
}

async function verifyRawFoundryBroadcast(rootDir, record) {
  if (!record.deployedNow) {
    return;
  }

  const broadcastRoot = path.resolve(rootDir, "broadcast");
  const broadcastPath = path.resolve(rootDir, record.foundryBroadcast);
  if (
    broadcastPath !== broadcastRoot &&
    !broadcastPath.startsWith(`${broadcastRoot}${path.sep}`)
  ) {
    throw new Error(
      `${record.network} Foundry broadcast path is outside broadcast/`,
    );
  }

  let foundryBroadcast;
  try {
    foundryBroadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${record.network} raw Foundry broadcast could not be read: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  const broadcastRouter = foundryBroadcast?.returns?.router?.value;
  if (
    !ADDRESS_PATTERN.test(broadcastRouter) ||
    broadcastRouter.toLowerCase() !== record.router.toLowerCase()
  ) {
    throw new Error(
      `${record.network} raw Foundry broadcast router does not match ${record.router}`,
    );
  }
  if (String(foundryBroadcast.chain) !== record.chainId) {
    throw new Error(
      `${record.network} raw Foundry broadcast chain does not match ${record.chainId}`,
    );
  }

  const broadcastTransactionHashes = (foundryBroadcast.transactions ?? []).map(
    ({ hash }) => hash,
  );
  if (
    JSON.stringify(broadcastTransactionHashes) !==
    JSON.stringify(record.transactionHashes)
  ) {
    throw new Error(
      `${record.network} transaction hashes do not match its raw Foundry broadcast`,
    );
  }
}

export async function verifyReleaseDeployments(
  releaseVersion,
  {
    rootDir = ROOT_DIR,
    networksFile = process.env.ALCHEMY_NETWORKS_FILE ?? DEFAULT_NETWORKS_FILE,
  } = {},
) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(releaseVersion)) {
    throw new Error(`invalid release version: ${releaseVersion}`);
  }

  const networks = parseNetworks(await readFile(networksFile, "utf8"));
  const releaseDir = path.join(
    rootDir,
    "broadcast",
    "releases",
    `v${releaseVersion}`,
  );
  const filenames = (await readdir(releaseDir)).filter((filename) =>
    filename.endsWith(".deployment.json"),
  );
  const records = await Promise.all(
    filenames.map(async (filename) =>
      JSON.parse(await readFile(path.join(releaseDir, filename), "utf8")),
    ),
  );
  const verified = verifyDeploymentRecords(networks, records);
  await Promise.all(
    verified.deployments.map((record) =>
      verifyRawFoundryBroadcast(rootDir, record),
    ),
  );
  const manifest = {
    version: releaseVersion,
    router: verified.router,
    runtimeCodeHash: verified.runtimeCodeHash,
    deployments: verified.deployments,
  };
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;

  await writeFile(
    path.join(releaseDir, "manifest.json"),
    serializedManifest,
  );
  await writeFile(
    path.join(rootDir, "broadcast", "deployments.json"),
    serializedManifest,
  );

  return manifest;
}

async function main() {
  const [releaseVersion] = process.argv.slice(2);
  if (!releaseVersion) {
    throw new Error("usage: verify-deployments.mjs <release-version>");
  }
  const manifest = await verifyReleaseDeployments(releaseVersion);
  process.stdout.write(`${manifest.router}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
