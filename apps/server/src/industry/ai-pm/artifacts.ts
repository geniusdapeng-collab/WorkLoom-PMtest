import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";
import { ArtifactCheckSchema, assertNoSecrets, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_FILE_BYTES, safeArtifactPath } from "./contract.js";
import { PmError, type ArtifactCheck, type PmArtifact, type PmFile, type PmScope } from "./types.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const INTERNAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const OBJECT_ID_PREFIX = "pma-v2-";
const OBJECT_DIRECTORY = "artifact-objects";
function internalId(id: string): string {
  if (!INTERNAL_ID.test(id)) throw new PmError("INVALID_ID", "任务编号格式无效");
  return id;
}

async function isDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PmError("UNSAFE_ARTIFACT_PATH", "产物目录不是普通目录或含符号链接");
}

/** Private server-owned objects; PostgreSQL receipts own the logical paths and authorize reads. */
export class ArtifactStore {
  private canonicalRoot?: Promise<string>;
  constructor(private readonly root: string) {}

  private rootDirectory(): Promise<string> {
    if (!this.canonicalRoot) this.canonicalRoot = (async () => {
      const path = resolve(this.root);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await isDirectory(path);
      return realpath(path); // trusted parent may be /var on macOS; all descendants are checked separately
    })();
    return this.canonicalRoot;
  }

  private async safeDirectory(root: string, parts: string[], create: boolean): Promise<string> {
    let current = root;
    await isDirectory(current);
    for (const part of parts) {
      current = join(current, part);
      if (create) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      await isDirectory(current);
    }
    const actual = await realpath(current);
    if (actual !== current || relative(root, actual).startsWith(`..${sep}`) || actual === root && parts.length > 0) {
      throw new PmError("UNSAFE_ARTIFACT_PATH", "产物目录越出服务器隔离范围");
    }
    return current;
  }

  async runDirectory(scope: PmScope, runId: string): Promise<string> {
    const root = await this.rootDirectory();
    const run = await this.safeDirectory(root, [hash(scope.tenantId), hash(scope.workspaceId), internalId(runId)], true);
    await this.safeDirectory(run, ["artifacts"], true);
    return run;
  }

  async scratchDirectory(scope: PmScope, runId: string, taskId: string): Promise<string> {
    const run = await this.runDirectory(scope, runId);
    return this.safeDirectory(run, ["scratch", internalId(taskId), randomUUID()], true);
  }

  /** Original storage for receipts issued before artifact IDs became physical object names. */
  private async resolveLegacyFile(scope: PmScope, runId: string, path: string): Promise<string> {
    const safe = safeArtifactPath(path);
    const run = await this.runDirectory(scope, runId);
    const parts = safe.split("/");
    await this.safeDirectory(join(run, "artifacts"), parts.slice(0, -1), false);
    return join(run, "artifacts", ...parts);
  }

  async resolveArtifactFile(scope: PmScope, runId: string, artifact: PmArtifact): Promise<string> {
    if (artifact.runId !== runId) throw new PmError("ARTIFACT_SCOPE_MISMATCH", "产物不属于当前任务", 404);
    const id = internalId(artifact.id);
    if (!id.startsWith(OBJECT_ID_PREFIX)) return this.resolveLegacyFile(scope, runId, artifact.path);
    safeArtifactPath(artifact.path);
    const run = await this.runDirectory(scope, runId);
    const directory = await this.safeDirectory(run, [OBJECT_DIRECTORY], false);
    return join(directory, id);
  }

  async persist(scope: PmScope, runId: string, taskId: string, files: PmFile[]): Promise<PmArtifact[]> {
    internalId(taskId);
    if (files.length < 1 || files.length > MAX_FILES) throw new PmError("INVALID_ARTIFACT_COUNT", "员工产物数量超出上限");
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      safeArtifactPath(file.path); assertNoSecrets(file.content);
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (!file.content.trim() || bytes > MAX_FILE_BYTES) throw new PmError("INVALID_ARTIFACT_SIZE", "产物为空或超过256KiB");
      if (seen.has(file.path.toLowerCase())) throw new PmError("DUPLICATE_ARTIFACT", "产物路径重复");
      seen.add(file.path.toLowerCase()); total += bytes;
    }
    if (total > MAX_TOTAL_FILE_BYTES) throw new PmError("ARTIFACTS_TOO_LARGE", "员工产物总量超过1MiB");
    const run = await this.runDirectory(scope, runId);
    const directory = await this.safeDirectory(run, [OBJECT_DIRECTORY], true);
    const written: string[] = [];
    try {
      const artifacts: PmArtifact[] = [];
      for (const file of files) {
        // Each attempt gets an independent object, even for an identical
        // logical path and hash. An interruption before DB commit cannot
        // occupy a later owner's output or authorize old bytes for readback.
        const id = `${OBJECT_ID_PREFIX}${randomUUID()}`;
        const path = join(directory, id);
        let handle;
        try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new PmError("ARTIFACT_ALREADY_EXISTS", "产物已存在或为符号链接，拒绝覆盖既有证据", 409);
          }
          throw error;
        }
        written.push(path);
        try { await handle.writeFile(file.content, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        const row: PmArtifact = {
          id, runId, taskId, path: file.path, sha256: hash(file.content),
          sizeBytes: Buffer.byteLength(file.content, "utf8"), mediaType: mediaType(file.path), verifiedAt: new Date().toISOString(),
        };
        // Verify the bytes before returning any receipt; an fs write result alone is insufficient.
        await this.readVerifiedFile(path, row);
        artifacts.push(row);
      }
      return artifacts;
    } catch (error) {
      // Remove only files created by this failed call. Existing evidence is never overwritten or deleted.
      const failures = await Promise.allSettled(written.map((path) => unlink(path)));
      if (failures.some((result) => result.status === "rejected")) {
        throw new PmError("ARTIFACT_RECONCILIATION_REQUIRED", "产物写入失败且清理不完整，需核对隔离目录后恢复", 409);
      }
      throw error;
    }
  }

  async read(scope: PmScope, runId: string, artifact: PmArtifact): Promise<string> {
    return this.readVerifiedFile(await this.resolveArtifactFile(scope, runId, artifact), artifact);
  }

  private async readVerifiedFile(path: string, artifact: PmArtifact): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size !== artifact.sizeBytes) {
        throw new PmError("ARTIFACT_HASH_MISMATCH", "产物大小校验不符，不能跳过或作为依赖");
      }
      const bytes = await handle.readFile();
      if (hash(bytes) !== artifact.sha256) throw new PmError("ARTIFACT_HASH_MISMATCH", "产物hash摘要校验不符，不能跳过或作为依赖");
      const text = bytes.toString("utf8"); assertNoSecrets(text); return text;
    } finally { await handle.close(); }
  }

  /**
   * Roll back files from a completed filesystem write whose database receipt
   * transaction did not commit. The caller must first re-read pm_artifacts and
   * prove every id is absent. Shared legacy paths cannot establish ownership.
   * For versioned objects, verify every hash/size before any unlink.
   */
  async discardUncommitted(scope: PmScope, runId: string, artifacts: PmArtifact[]): Promise<number> {
    const paths = new Set<string>();
    for (const artifact of artifacts) {
      if (!artifact.id.startsWith(OBJECT_ID_PREFIX)) {
        throw new PmError("ARTIFACT_RECONCILIATION_REQUIRED", "旧版产物路径不能证明写入归属，保留文件等待对账", 409);
      }
      try {
        const path = await this.resolveArtifactFile(scope, runId, artifact);
        await this.readVerifiedFile(path, artifact);
        paths.add(path);
      } catch (error) {
        // Already absent is the desired end state. Any other mismatch aborts
        // before unlink so remaining evidence stays available for reconciliation.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let removed = 0;
    for (const path of paths) {
      try {
        await unlink(path);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
}

function mediaType(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".json" ? "application/json" : ext === ".md" ? "text/markdown" : ext === ".html" ? "text/html" : "text/plain";
}

export interface CheckResult { check: ArtifactCheck; passed: boolean; message: string }
/** All HTTP-supplied checks are pure reads. There is no shell, eval, dynamic import or regex execution. */
export function runArtifactChecks(files: PmFile[], checks: ArtifactCheck[]): CheckResult[] {
  return checks.map((input) => {
    const check = ArtifactCheckSchema.parse(input);
    const file = files.find((item) => item.path === check.path);
    if (!file) return { check, passed: false, message: "缺少指定产物" };
    if (check.type === "fileExists") return { check, passed: true, message: "产物存在" };
    if (check.type === "fileContains") return { check, passed: file.content.includes(check.text), message: "字面内容断言" };
    try {
      const value: unknown = JSON.parse(file.content);
      const keys = check.requiredKeys ?? [];
      const passed = keys.length === 0 || !!value && typeof value === "object" && !Array.isArray(value)
        && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
      return { check, passed, message: "JSON解析与顶层字段断言" };
    } catch { return { check, passed: false, message: "产物不是合法JSON" }; }
  });
}
