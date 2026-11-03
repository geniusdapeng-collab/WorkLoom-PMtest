#!/usr/bin/env node
/** Verify packaged tokenizer assets and execute them without build-tree imports. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TOKENIZER_SHA256 = "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99";
const FILES = ["deepseek-window.ts", "assets/deepseek-v41/tokenizer.json", "assets/deepseek-v41/provenance.json",
  "assets/deepseek-v41/LICENSE-RECIPE.txt", "assets/deepseek-v41/LICENSE-TOKENIZER.txt", "assets/deepseek-v41/README.md"];

export async function verifyRuntimeDeepSeek({ runtimeRoot, nodeModulesRoot }) {
  const root = await realpath(resolve(runtimeRoot));
  const modules = await realpath(resolve(nodeModulesRoot));
  const source = join(root, "packages/base/model-router");
  const installed = join(root, "node_modules/@workloom/base/model-router");
  const contents = new Map();
  for (const path of FILES) {
    const original = await readFile(join(source, path));
    if (sha256(original) !== sha256(await readFile(join(installed, path)))) throw new Error(`DeepSeek 载荷两份文件不一致：${path}`);
    contents.set(path, original);
  }
  const asset = "assets/deepseek-v41/";
  const provenance = JSON.parse(contents.get(`${asset}provenance.json`).toString("utf8"));
  if (sha256(contents.get(`${asset}tokenizer.json`)) !== TOKENIZER_SHA256 || provenance.tokenizerSha256 !== TOKENIZER_SHA256) {
    throw new Error("DeepSeek 载荷 tokenizer SHA-256 不匹配");
  }
  if (provenance.recipeVersion !== "0.2.0" || provenance.recipeCommit !== "935817c66f5d6e64838f419692545f06787e485f"
    || provenance.contextTokens !== 1048576 || provenance.maxOutputTokens !== 393216) throw new Error("DeepSeek 载荷来源或窗口不匹配");
  for (const name of ["LICENSE-RECIPE.txt", "LICENSE-TOKENIZER.txt"]) {
    if (sha256(contents.get(`${asset}${name}`)) !== provenance.licenses?.[name]) throw new Error(`DeepSeek 许可摘要不匹配：${name}`);
  }
  const require = createRequire(join(modules, ".workloom-deepseek-verifier.cjs"));
  const engineFile = await realpath(require.resolve("@huggingface/tokenizers"));
  if (!engineFile.startsWith(`${modules}${sep}`)) throw new Error("DeepSeek BPE 引擎逃逸生产依赖目录");
  const engineRoot = dirname(dirname(engineFile));
  const engine = JSON.parse(await readFile(join(engineRoot, "package.json"), "utf8"));
  if (engine.name !== "@huggingface/tokenizers" || engine.version !== "0.2.0" || engine.license !== "Apache-2.0") throw new Error("DeepSeek BPE 引擎未按来源锁定");
  if (!(await readFile(join(engineRoot, "LICENSE"), "utf8")).includes("Apache License")) throw new Error("DeepSeek BPE 引擎许可缺失");
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "workloom-deepseek-runtime-")));
  try {
    for (const [path, data] of contents) {
      const target = join(fixture, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
    await symlink(modules, join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const smoke = `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encodeDeepSeekRequest, planDeepSeekWindow } from './deepseek-window.ts';
globalThis.fetch = () => { throw new Error('Tokenizer must not use the network'); };
const p = JSON.parse(await readFile(new URL('./assets/deepseek-v41/provenance.json', import.meta.url), 'utf8'));
const checks = [];
assert.ok(p.verification.smokeCases.length >= 2);
for (const c of p.verification.smokeCases) {
  const encoded = await encodeDeepSeekRequest(c.body);
  assert.equal(encoded.tokenIds.length, c.inputTokens);
  assert.equal(createHash('sha256').update(JSON.stringify(encoded.tokenIds)).digest('hex'), c.tokenIdsSha256);
  const plan = await planDeepSeekWindow(c.body);
  assert.equal(plan.fullInputTokens, c.inputTokens);
  assert.equal(plan.maxOutputTokens, Math.min(393216, 1048576 - c.inputTokens));
  checks.push({ id: c.id, inputTokens: c.inputTokens, maxOutputTokens: plan.maxOutputTokens });
}
console.log(JSON.stringify(checks));
`;
    await writeFile(join(fixture, "smoke.mjs"), smoke);
    const env = { ...process.env };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    // Node 24's native type stripping executes this erasable TypeScript module.
    // No build-machine compiler or target-specific esbuild binary is involved,
    // so the same pure-JS smoke also works for foreign-platform payloads.
    const result = await run(process.execPath, [join(fixture, "smoke.mjs")],
      { cwd: fixture, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { schemaVersion: "workloom.runtime-deepseek/v1", tokenizerSha256: TOKENIZER_SHA256,
      engine: `${engine.name}@${engine.version}`, offline: true, checks: JSON.parse(result.stdout.trim()) };
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyRuntimeDeepSeek({ runtimeRoot: process.argv[2], nodeModulesRoot: process.argv[3] }))); }
  catch (error) { console.error(`DeepSeek 生产载荷验证失败：${error.message}`); process.exitCode = 1; }
}
