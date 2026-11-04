import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, runArtifactChecks } from "./artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const scope = { tenantId: "tenant-a", workspaceId: "ws-a" };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pm-artifacts-")); roots.push(root);
  return { root, store: new ArtifactStore(root) };
}

describe("MC-PM-002 真实文件回执和安全纯读检查", () => {
  it("写真实文件并核验hash；相同逻辑路径的新尝试拥有独立物理文件", async () => {
    const { store } = await setup();
    const path = "docs/result.md";
    const [original] = await store.persist(scope, "run-a", "task-a", [{ path, content: "可测试的实际内容" }]);
    const [retry] = await store.persist(scope, "run-a", "task-a", [{ path, content: "新的实际内容" }]);
    expect(original!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(original!.id).not.toBe(retry!.id);
    expect(original!.path).toBe(retry!.path);
    expect(await store.read(scope, "run-a", original!)).toBe("可测试的实际内容");
    expect(await store.read(scope, "run-a", retry!)).toBe("新的实际内容");
    await expect(store.persist(scope, "run-a", "task-a", [
      { path, content: "第一个文件" }, { path: "docs/Result.md", content: "重复文件" },
    ])).rejects.toMatchObject({ code: "DUPLICATE_ARTIFACT" });
  });
  it("旧回执保持原物理路径，缺失新版对象时拒绝借用同逻辑路径的旧字节", async () => {
    const { store } = await setup();
    const run = await store.runDirectory(scope, "run-a");
    const content = "historical bytes";
    const path = "result.md";
    const legacyPath = join(run, "artifacts", path);
    await writeFile(legacyPath, content);
    const legacy = { id: "pma-5e96b2ed-2aac-4087-9da8-2c3382cd0188", runId: "run-a", taskId: "task-a",
      path, sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content),
      mediaType: "text/markdown", verifiedAt: new Date().toISOString() };
    expect(await store.read(scope, "run-a", legacy)).toBe(content);
    const [versioned] = await store.persist(scope, "run-a", "task-a", [{ path, content }]);
    expect(await store.read(scope, "run-a", versioned!)).toBe(content);
    await unlink(await store.resolveArtifactFile(scope, "run-a", versioned!));
    await expect(store.read(scope, "run-a", versioned!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.discardUncommitted(scope, "run-a", [legacy])).rejects.toMatchObject({ code: "ARTIFACT_RECONCILIATION_REQUIRED" });
    expect(await store.read(scope, "run-a", legacy)).toBe(content);
  });
  it("篡改后拒读取和resume跳过", async () => {
    const { store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "original" }]);
    const file = await store.resolveArtifactFile(scope, "run-a", row!);
    await writeFile(file, "tampered");
    await expect(store.read(scope, "run-a", row!)).rejects.toThrow(/hash|摘要|校验/);
  });
  it("只回滚哈希仍匹配的未提交文件；被替换的字节保留等待对账", async () => {
    const { store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "uncommitted" }]);
    expect(await store.discardUncommitted(scope, "run-a", [row!])).toBe(1);
    const path = await store.resolveArtifactFile(scope, "run-a", row!);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const [changed] = await store.persist(scope, "run-a", "task-b", [{ path: "changed.md", content: "original" }]);
    const changedPath = await store.resolveArtifactFile(scope, "run-a", changed!);
    await writeFile(changedPath, "replacement");
    await expect(store.discardUncommitted(scope, "run-a", [changed!])).rejects.toThrow(/hash|摘要|校验/);
    expect(await readFile(changedPath, "utf8")).toBe("replacement");
  });
  it("拒跨租户、工作区、运行、路径穿越和对象符号链接", async () => {
    const { root, store } = await setup();
    const [row] = await store.persist(scope, "run-a", "task-a", [{ path: "result.md", content: "private" }]);
    await expect(store.read({ ...scope, workspaceId: "ws-b" }, "run-a", row!)).rejects.toThrow();
    await expect(store.read({ ...scope, tenantId: "tenant-b" }, "run-a", row!)).rejects.toThrow();
    await expect(store.read(scope, "run-b", row!)).rejects.toMatchObject({ code: "ARTIFACT_SCOPE_MISMATCH" });
    await expect(store.discardUncommitted(scope, "run-b", [row!])).rejects.toMatchObject({ code: "ARTIFACT_SCOPE_MISMATCH" });
    await expect(store.persist(scope, "run-a", "task-a", [{ path: "../escape.md", content: "bad" }])).rejects.toMatchObject({ code: "UNSAFE_ARTIFACT_PATH" });
    await expect(store.read(scope, "run-a", { ...row!, id: "pma-v2-../x" })).rejects.toMatchObject({ code: "INVALID_ID" });
    const outside = join(root, "outside"); await mkdir(outside);
    const runDir = await store.runDirectory(scope, "run-symlink");
    await symlink(outside, join(runDir, "artifact-objects"));
    await expect(store.persist(scope, "run-symlink", "task-a", [{ path: "a.md", content: "bad" }])).rejects.toMatchObject({ code: "UNSAFE_ARTIFACT_PATH" });
    await symlink(outside, join(runDir, "artifacts", "escaped"));
    await expect(store.read(scope, "run-symlink", { ...row!, id: "pma-legacy", runId: "run-symlink", path: "escaped/a.md" }))
      .rejects.toMatchObject({ code: "UNSAFE_ARTIFACT_PATH" });
    const realPath = await store.resolveArtifactFile(scope, "run-a", row!);
    const outsideFile = join(outside, "a.md");
    await writeFile(outsideFile, "private");
    await unlink(realPath);
    await symlink(outsideFile, realPath);
    await expect(store.read(scope, "run-a", row!)).rejects.toThrow();
    await expect(store.discardUncommitted(scope, "run-a", [row!])).rejects.toThrow();
    expect(await readFile(outsideFile, "utf8")).toBe("private");
  });
  it("检查只允许exists/contains/json，不执行模型生成代码", () => {
    const files = [{ path: "data.json", content: '{"count":3,"valid":true}' }, { path: "app.js", content: 'throw new Error("must never execute")' }];
    expect(runArtifactChecks(files, [{ type: "fileExists", path: "app.js" }, { type: "fileContains", path: "data.json", text: '"count":3' }, { type: "json", path: "data.json", requiredKeys: ["count", "valid"] }]).every((row) => row.passed)).toBe(true);
    expect(runArtifactChecks(files, [{ type: "json", path: "data.json", requiredKeys: ["missing"] }])[0]!.passed).toBe(false);
    expect(() => runArtifactChecks(files, [{ type: "shell", path: "app.js" } as never])).toThrow();
  });
});
