#!/usr/bin/env node
/**
 * 正式桌面载荷的产品边界策略。
 *
 * platform-ops 是仙女座的平台运营运维源码，不是 WorkLoom IM 公共基座能力。
 * 目录是否碰巧存在不能成为装包依据；只有受保护产品身份精确匹配仙女座时
 * 才允许进入载荷，其他产品（包括基座、行业与试验田）一律排除并在装包后复核。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductRuntime } from "./product-runtime.mjs";

const ANDROMEDA_IDENTITY = Object.freeze({
  productId: "workroom-andromeda",
  role: "operations-hub",
  repository: "workloom-ai/workroom-andromeda",
});

const PLATFORM_OPS_RUNTIME_PATHS = Object.freeze([
  "platform-ops",
  "node_modules/@workloom/platform-ops",
]);

export const REQUIRED_RUNTIME_IDENTITY_PATHS = Object.freeze([
  "product.manifest.json",
  "scripts/vite-product.mjs",
  "scripts/product-runtime.mjs",
  "apps/web/vite.config.ts",
]);

const PRODUCT_IDENTITY_FIELDS = Object.freeze([
  "schemaVersion",
  "productId",
  "role",
  "displayName",
  "repository",
  "demoWorkspaceSlug",
  "demoMemberNo",
  "portOffset",
]);

function exactIdentity(product, expected) {
  return Object.entries(expected).every(([field, value]) => product[field] === value);
}

function manifestIdentityFor(product) {
  return Object.freeze(Object.fromEntries(PRODUCT_IDENTITY_FIELDS.map((field) => [
    field,
    field === "portOffset" ? (product.portOffset ?? product.desktop?.portOffset) : product[field],
  ])));
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function payloadPolicyFor(product) {
  if (!product || typeof product !== "object") throw new Error("缺少已校验的产品身份");
  const includePlatformOps = exactIdentity(product, ANDROMEDA_IDENTITY);
  return Object.freeze({
    productId: product.productId,
    role: product.role,
    repository: product.repository,
    manifestIdentity: manifestIdentityFor(product),
    manifestSha256: typeof product.manifestPath === "string" ? fileSha256(product.manifestPath) : null,
    includePlatformOps,
    forbiddenRuntimePaths: Object.freeze(includePlatformOps ? [] : [...PLATFORM_OPS_RUNTIME_PATHS]),
  });
}

export function loadPayloadPolicy(start) {
  return payloadPolicyFor(loadProductRuntime(start));
}

function normalizeArchiveFilePath(value) {
  const parts = String(value)
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  const normalized = [];
  for (const part of parts) {
    if (part === "..") {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join("/");
}

function normalizeArchivePath(value) {
  return normalizeArchiveFilePath(value).toLowerCase();
}

function isSeedScript(name) {
  return /^seed[^/]*\.(?:[cm]?[jt]s)$/iu.test(name);
}

function hasBundleSeedPath(path) {
  return /^bundles(?:\/[^/]+)*\/seeds(?:\/|$)/u.test(path);
}

function isForbiddenArchiveEntry(entry, forbiddenRuntimePath) {
  const normalized = normalizeArchivePath(entry);
  const forbidden = normalizeArchivePath(`runtime/${forbiddenRuntimePath}`);
  return normalized === forbidden || normalized.startsWith(`${forbidden}/`);
}

export function findForbiddenArchiveEntries(entries, policy) {
  return entries.filter((entry) => policy.forbiddenRuntimePaths.some(
    (forbidden) => isForbiddenArchiveEntry(entry, forbidden),
  ));
}

export function assertRuntimePayloadBoundary(runtimeRoot, policy) {
  const resolvedRoot = resolve(runtimeRoot);
  const missingIdentityFiles = REQUIRED_RUNTIME_IDENTITY_PATHS.filter((relativePath) => {
    const candidate = resolve(resolvedRoot, ...relativePath.split("/"));
    return !existsSync(candidate) || !statSync(candidate).isFile();
  });
  if (missingIdentityFiles.length > 0) {
    throw new Error(`产品身份载荷不完整：缺少 ${missingIdentityFiles.join("、")}`);
  }

  const runtimeProduct = loadProductRuntime(resolvedRoot);
  const identityMismatches = PRODUCT_IDENTITY_FIELDS.filter(
    (field) => runtimeProduct[field] !== policy.manifestIdentity?.[field],
  );
  if (identityMismatches.length > 0) {
    throw new Error(`载荷产品身份与源策略不一致：${identityMismatches.join("、")}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(policy.manifestSha256 ?? "")) {
    throw new Error("源策略缺少可信的产品清单摘要");
  }
  if (fileSha256(runtimeProduct.manifestPath) !== policy.manifestSha256) {
    throw new Error("载荷产品清单与源策略不一致：SHA-256 不匹配");
  }

  const seedScripts = readdirSync(resolve(resolvedRoot, "scripts")).filter(isSeedScript);
  if (seedScripts.length > 0) {
    throw new Error(`正式桌面载荷不得包含示例数据脚本：${seedScripts.join("、")}`);
  }
  for (const template of [".env.defaults", ".env.example"]) {
    const file = resolve(resolvedRoot, template);
    if (existsSync(file) && /^\s*(?:export\s+)?DESKTOP_SEED_SCRIPT\s*=/mu.test(readFileSync(file, "utf8"))) {
      throw new Error(`正式桌面载荷配置了示例数据脚本：${template}`);
    }
  }
  const bundles = resolve(resolvedRoot, "bundles");
  if (existsSync(bundles)) {
    const paths = readdirSync(bundles, { recursive: true });
    if (paths.some((entry) => hasBundleSeedPath(normalizeArchivePath(`bundles/${entry}`)))) {
      throw new Error("正式桌面载荷不得包含行业包示例数据目录");
    }
    for (const bundle of readdirSync(bundles, { withFileTypes: true })) {
      if (!bundle.isDirectory()) continue;
      const file = resolve(bundles, bundle.name, "bundle.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (manifest.workloom?.provides?.seeds?.length) {
        throw new Error(`正式桌面行业包仍声明示例数据：${bundle.name}`);
      }
    }
  }

  const leaks = policy.forbiddenRuntimePaths.filter((relativePath) => {
    const candidate = resolve(resolvedRoot, ...relativePath.split("/"));
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`非法载荷边界路径：${relativePath}`);
    }
    return existsSync(candidate);
  });
  if (leaks.length > 0) {
    throw new Error(`平台工程边界违规：${leaks.join("、")} 不得进入 ${policy.productId} 正式载荷`);
  }
}

export function assertArchivePayloadBoundary(entries, policy) {
  const leaks = findForbiddenArchiveEntries(entries, policy);
  if (leaks.length > 0) {
    throw new Error(`平台工程边界违规：归档包含 ${leaks.join("、")}`);
  }
  const scriptsPrefix = "runtime/scripts/";
  const seedScripts = entries.filter((entry) => {
    const path = normalizeArchivePath(entry);
    return (path.startsWith(scriptsPrefix) && isSeedScript(path.slice(scriptsPrefix.length)))
      || (path.startsWith("runtime/") && hasBundleSeedPath(path.slice("runtime/".length)));
  });
  if (seedScripts.length > 0) {
    throw new Error(`正式桌面归档不得包含示例数据脚本：${seedScripts.join("、")}`);
  }
  const archivedFiles = new Set(entries
    .filter((entry) => !/[\\/]$/u.test(String(entry)))
    .map((entry) => normalizeArchiveFilePath(entry)));
  const missingIdentityFiles = REQUIRED_RUNTIME_IDENTITY_PATHS.filter(
    (relativePath) => !archivedFiles.has(normalizeArchiveFilePath(`runtime/${relativePath}`)),
  );
  if (missingIdentityFiles.length > 0) {
    throw new Error(`产品身份归档不完整：缺少 ${missingIdentityFiles.join("、")}`);
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const [command, value] = process.argv.slice(2);
  const policy = loadPayloadPolicy();
  switch (command) {
    case "platform-ops-mode":
      process.stdout.write(`${policy.includePlatformOps ? "include" : "exclude"}\n`);
      break;
    case "assert-runtime":
      if (!value) throw new Error("用法：payload-policy.mjs assert-runtime <runtime 目录>");
      assertRuntimePayloadBoundary(value, policy);
      break;
    case "assert-archive-list": {
      const entries = (await readStdin()).split(/\r?\n/u).filter(Boolean);
      assertArchivePayloadBoundary(entries, policy);
      break;
    }
    default:
      throw new Error("用法：payload-policy.mjs platform-ops-mode | assert-runtime <目录> | assert-archive-list");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
