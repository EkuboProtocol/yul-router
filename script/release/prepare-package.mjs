import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
const PACKAGE_NAME = "@ekubo/yul-router-sdk";
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ROUTER_DECLARATION_PATTERN =
  /export const YUL_ROUTER_ADDRESS: Address =\s*\n\s*"0x[0-9a-fA-F]{40}";/g;

export function validateVersion(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`version must be an exact semantic version: ${version}`);
  }
  return version;
}

export function updatePackageJson(contents, version) {
  validateVersion(version);
  const packageJson = JSON.parse(contents);
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`unexpected package name: ${packageJson.name}`);
  }
  packageJson.version = version;
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

export function updateRouterAddress(contents, routerAddress) {
  if (!ADDRESS_PATTERN.test(routerAddress)) {
    throw new Error(`invalid router address: ${routerAddress}`);
  }
  const matches = [...contents.matchAll(ROUTER_DECLARATION_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(
      `expected one YUL_ROUTER_ADDRESS declaration, found ${matches.length}`,
    );
  }
  return contents.replace(
    ROUTER_DECLARATION_PATTERN,
    `export const YUL_ROUTER_ADDRESS: Address =\n  "${routerAddress}";`,
  );
}

export async function preparePackageRelease(
  version,
  routerAddress,
  { rootDir = ROOT_DIR } = {},
) {
  validateVersion(version);
  const packagePath = path.join(rootDir, "sdk", "package.json");
  const sourcePath = path.join(rootDir, "sdk", "src", "index.ts");
  const [packageContents, sourceContents] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(sourcePath, "utf8"),
  ]);

  await Promise.all([
    writeFile(packagePath, updatePackageJson(packageContents, version)),
    writeFile(sourcePath, updateRouterAddress(sourceContents, routerAddress)),
  ]);
}

async function main() {
  const [commandOrVersion, routerAddress] = process.argv.slice(2);
  if (commandOrVersion === "--check-version") {
    validateVersion(routerAddress);
    return;
  }
  if (!commandOrVersion || !routerAddress) {
    throw new Error(
      "usage: prepare-package.mjs <version> <router-address>",
    );
  }
  await preparePackageRelease(commandOrVersion, routerAddress);
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
