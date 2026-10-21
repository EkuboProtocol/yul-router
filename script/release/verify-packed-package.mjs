import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateVersion } from "./prepare-package.mjs";
import { parseNetworks, verifyDeploymentRecords } from "./verify-deployments.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_NETWORKS_FILE = path.join(SCRIPT_DIR, "alchemy-networks.txt");
const PACKAGE_NAME = "@ekubo/yul-router-sdk";
const ROUTER_EXPORT = "YUL_ROUTER_ADDRESS";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_LITERAL_PATTERN = /0x[0-9a-fA-F]{40}/g;
// The only non-router address literal the SDK legitimately embeds (an empty
// authorized-locker default); any other address in the entrypoint must be the router.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// npm always packs package.json and the README; everything else must come from dist/.
const ALLOWED_TARBALL_ENTRY = /^package\/(package\.json|README(\.[^/]*)?|LICENSE(\.[^/]*)?|dist\/[^/]+)$/;

const execFileAsync = promisify(execFile);

function normalizeAddress(address) {
  return address.toLowerCase();
}

/**
 * Loads the manifest the release flow wrote for this version and re-runs the
 * all-chain deployment verification on it, so the packed artifact is compared
 * against the same records that were verified after deployment, not against a
 * second list of addresses.
 */
export async function loadVerifiedManifest(
  releaseVersion,
  { rootDir = ROOT_DIR, networksFile = DEFAULT_NETWORKS_FILE } = {},
) {
  validateVersion(releaseVersion);
  const manifestPath = path.join(
    rootDir,
    "broadcast",
    "releases",
    `v${releaseVersion}`,
    "manifest.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `no verified deployment manifest for v${releaseVersion}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  if (manifest.version !== releaseVersion) {
    throw new Error(
      `manifest version mismatch: ${manifestPath} records ${manifest.version}, expected ${releaseVersion}`,
    );
  }

  const networks = parseNetworks(await readFile(networksFile, "utf8"));
  const verified = verifyDeploymentRecords(networks, manifest.deployments ?? []);
  if (
    !ADDRESS_PATTERN.test(manifest.router) ||
    normalizeAddress(manifest.router) !== normalizeAddress(verified.router)
  ) {
    throw new Error(
      `manifest router ${manifest.router} does not match its deployment records (${verified.router})`,
    );
  }

  const current = JSON.parse(
    await readFile(path.join(rootDir, "broadcast", "deployments.json"), "utf8"),
  );
  if (
    current.version !== manifest.version ||
    normalizeAddress(current.router) !== normalizeAddress(manifest.router)
  ) {
    throw new Error(
      `broadcast/deployments.json records v${current.version} at ${current.router}, expected v${manifest.version} at ${manifest.router}`,
    );
  }

  return {
    version: manifest.version,
    router: verified.router,
    chainIds: verified.deployments.map(({ chainId }) => chainId),
  };
}

/**
 * Router addresses recorded by every other release manifest, used to name a
 * stale address rather than only calling it unknown.
 */
export async function loadHistoricalRouters(releaseVersion, { rootDir = ROOT_DIR } = {}) {
  const releasesDir = path.join(rootDir, "broadcast", "releases");
  const routers = new Map();
  for (const entry of await readdir(releasesDir)) {
    if (entry === `v${releaseVersion}`) {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(releasesDir, entry, "manifest.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (ADDRESS_PATTERN.test(manifest.router)) {
      const key = normalizeAddress(manifest.router);
      routers.set(key, [...(routers.get(key) ?? []), entry]);
    }
  }
  return routers;
}

async function listTarball(tarballPath) {
  const { stdout } = await execFileAsync("tar", ["-tzf", tarballPath]);
  // Directory entries end in "/"; only files are checked against the allow-list.
  return stdout.split("\n").filter((line) => line && !line.endsWith("/"));
}

export function resolveRuntimeEntrypoint(packageJson) {
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`unexpected package name: ${packageJson.name}`);
  }
  const root = packageJson.exports?.["."];
  const entry =
    (typeof root === "string" ? root : root?.import ?? root?.default) ??
    packageJson.main;
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    throw new Error(`package.json does not declare a runtime entrypoint`);
  }
  return entry.slice(2);
}

async function loadRuntimeExports(packageDir, entrypoint, sdkNodeModules) {
  const entryPath = path.join(packageDir, entrypoint);
  await access(entryPath).catch(() => {
    throw new Error(`runtime entrypoint ${entrypoint} is not in the tarball`);
  });
  // The packed entrypoint imports its peer dependency by bare specifier, so the
  // extracted copy borrows the SDK's installed node_modules through a symlink
  // one directory above package/.
  await symlink(sdkNodeModules, path.join(path.dirname(packageDir), "node_modules"), "dir");
  if (entryPath.endsWith(".cjs")) {
    return createRequire(entryPath)(entryPath);
  }
  return import(pathToFileURL(entryPath).href);
}

function describeAddress(address, manifest, historical) {
  const key = normalizeAddress(address);
  if (key === normalizeAddress(manifest.router)) {
    return null;
  }
  const releases = historical.get(key);
  if (releases) {
    return `stale router address ${address}: it was the router of ${releases.join(", ")}, but v${manifest.version} is deployed at ${manifest.router}`;
  }
  return `unknown router address ${address}: v${manifest.version} is deployed at ${manifest.router}`;
}

/**
 * Verifies that the npm tarball about to be published targets the router that
 * the release's deployment records verified, on the version they record.
 */
export async function verifyPackedPackage(
  releaseVersion,
  tarballPath,
  {
    rootDir = ROOT_DIR,
    networksFile = process.env.ALCHEMY_NETWORKS_FILE ?? DEFAULT_NETWORKS_FILE,
  } = {},
) {
  const manifest = await loadVerifiedManifest(releaseVersion, { rootDir, networksFile });
  const historical = await loadHistoricalRouters(releaseVersion, { rootDir });
  const tarball = await readFile(tarballPath);
  const sha256 = createHash("sha256").update(tarball).digest("hex");

  const entries = await listTarball(tarballPath);
  const unexpected = entries.filter((entry) => !ALLOWED_TARBALL_ENTRY.test(entry));
  if (unexpected.length > 0) {
    throw new Error(`tarball contains unexpected files: ${unexpected.join(", ")}`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "yul-router-packed-"));
  try {
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", workDir]);
    const packageDir = path.join(workDir, "package");
    const packageJson = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    );
    if (packageJson.version !== releaseVersion) {
      throw new Error(
        `packed package.json is version ${packageJson.version}, expected ${releaseVersion}`,
      );
    }
    const entrypoint = resolveRuntimeEntrypoint(packageJson);
    const source = await readFile(path.join(packageDir, entrypoint), "utf8").catch(() => {
      throw new Error(`runtime entrypoint ${entrypoint} is not in the tarball`);
    });

    const literals = [...new Set(source.match(ADDRESS_LITERAL_PATTERN) ?? [])];
    const literalProblems = literals
      .filter((address) => address !== ZERO_ADDRESS)
      .map((address) => describeAddress(address, manifest, historical))
      .filter(Boolean);
    if (literalProblems.length > 0) {
      throw new Error(`${entrypoint} embeds ${literalProblems.join("; ")}`);
    }

    const runtime = await loadRuntimeExports(
      packageDir,
      entrypoint,
      path.join(rootDir, "sdk", "node_modules"),
    );
    const exported = runtime[ROUTER_EXPORT];
    if (typeof exported !== "string" || !ADDRESS_PATTERN.test(exported)) {
      throw new Error(`${entrypoint} does not export a valid ${ROUTER_EXPORT}`);
    }
    const problem = describeAddress(exported, manifest, historical);
    if (problem) {
      throw new Error(`${entrypoint} exports ${problem}`);
    }

    return {
      package: `${packageJson.name}@${packageJson.version}`,
      tarball: path.basename(tarballPath),
      sha256,
      entrypoint,
      router: exported,
      version: manifest.version,
      chainIds: manifest.chainIds,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const [releaseVersion, tarballPath] = process.argv.slice(2);
  if (!releaseVersion || !tarballPath) {
    throw new Error("usage: verify-packed-package.mjs <release-version> <tarball>");
  }
  const result = await verifyPackedPackage(releaseVersion, path.resolve(tarballPath));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
