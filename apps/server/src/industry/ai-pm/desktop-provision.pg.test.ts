import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loginWithPassword, UnavailableSms } from "@workloom/base/accounts";
import { bundlesRoot, loadVerifiedBundleManifest } from "@workloom/base/bundles";
import { DesktopSetupEmailConflictError, DesktopSetupUnavailableError, desktopProvisionAvailable, provisionDesktopWorkspace } from "./desktop-provision.js";

const databaseUrl = process.env.WORKLOOM_DESKTOP_PROVISION_TEST_DATABASE_URL;
type FixtureManifest = ReturnType<typeof loadVerifiedBundleManifest>;
const input = {
  tenantName: "开通验证组织", workspaceName: "升级验证工作区", displayName: "正式所有者",
  email: "owner@desktop-setup.invalid", password: randomBytes(20).toString("hex"),
};

describe.skipIf(!databaseUrl)("桌面生产首启的 PostgreSQL 原子开通", () => {
  let pool: pg.Pool;
  let scratch: string;
  let signedRoot: string;
  let trustPath: string;
  let canonicalBundleArtifactPayload: (manifest: FixtureManifest) => string;

  beforeAll(async () => {
    const endpoint = databaseUrl ? new URL(databaseUrl) : undefined;
    if (!endpoint || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      || !/^\/workloom_pm_desktop_provision_test_[a-z0-9_]+$/u.test(endpoint.pathname)) {
      throw new Error("开通验收仅允许独立的一次性已迁移数据库 workloom_pm_desktop_provision_test_*");
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
    const initial = await pool.query(`SELECT EXISTS(SELECT 1 FROM workspaces) OR EXISTS(SELECT 1 FROM accounts)
      OR EXISTS(SELECT 1 FROM tenants) AS occupied`);
    expect(initial.rows[0].occupied).toBe(false);
    scratch = mkdtempSync(join(tmpdir(), "pm-desktop-provision-test-"));
    signedRoot = join(scratch, "bundles");
    trustPath = join(scratch, "trust.json");
    cpSync(join(bundlesRoot(), "ai-pm"), join(signedRoot, "ai-pm"), { recursive: true });
    const path = join(signedRoot, "ai-pm", "bundle.json");
    // The credential is generated in this fixture using the same canonical function as the release signer.
    const contractPath = new URL("../../../../../packages/industry-contract/src/index.ts", import.meta.url);
    ({ canonicalBundleArtifactPayload } = await import(contractPath.href) as {
      canonicalBundleArtifactPayload: typeof canonicalBundleArtifactPayload;
    });
    const manifest = loadVerifiedBundleManifest("ai-pm", signedRoot);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "disposable-desktop-provision-fixture";
    manifest.workloom.status = "stable";
    manifest.workloom.example = false;
    const digest = createHash("sha256").update(canonicalBundleArtifactPayload(manifest)).digest("hex");
    manifest.integrity = { algorithm: "sha256", digest, assets: manifest.integrity!.assets,
      signature: { algorithm: "ed25519", keyId, value: sign(null, Buffer.from(digest, "hex"), privateKey).toString("base64") } };
    writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(trustPath, JSON.stringify({ keys: { [keyId]: publicKey.export({ type: "spki", format: "pem" }) }, revoked: [] }));
    vi.stubEnv("BUNDLE_TRUST_PATH", trustPath);
    vi.stubEnv("BUNDLE_VERIFICATION_KEYS", undefined);
    vi.stubEnv("JWT_SECRET", "desktop-provision-fixture-jwt-secret-unshared");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("拒绝候选、未信任与被改动的稳定制品，并允许通过签名与目录校验的制品", async () => {
    const options = { pool, bundleRoot: signedRoot };
    const manifestPath = join(signedRoot, "ai-pm", "bundle.json");
    const signed = readFileSync(manifestPath, "utf8");
    const candidate = JSON.parse(signed) as FixtureManifest;
    candidate.workloom.status = "candidate";
    delete candidate.integrity!.signature;
    candidate.integrity!.digest = createHash("sha256").update(canonicalBundleArtifactPayload(candidate)).digest("hex");
    try {
      writeFileSync(manifestPath, JSON.stringify(candidate));
      await expect(desktopProvisionAvailable(options)).rejects.toBeInstanceOf(DesktopSetupUnavailableError);
      await expect(provisionDesktopWorkspace(input, options)).rejects.toBeInstanceOf(DesktopSetupUnavailableError);
    } finally {
      writeFileSync(manifestPath, signed);
    }
    vi.stubEnv("BUNDLE_TRUST_PATH", undefined);
    await expect(desktopProvisionAvailable(options)).rejects.toBeInstanceOf(DesktopSetupUnavailableError);
    vi.stubEnv("BUNDLE_TRUST_PATH", trustPath);
    const skillPath = join(signedRoot, "ai-pm", "skills", "dev-dispatch", "SKILL.md");
    const original = readFileSync(skillPath);
    try {
      writeFileSync(skillPath, Buffer.concat([original, Buffer.from("\nmodified\n")]));
      await expect(desktopProvisionAvailable(options)).rejects.toBeInstanceOf(DesktopSetupUnavailableError);
      await expect(provisionDesktopWorkspace(input, options)).rejects.toBeInstanceOf(DesktopSetupUnavailableError);
    } finally {
      writeFileSync(skillPath, original);
    }
    expect(await desktopProvisionAvailable(options)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM accounts")).rows[0].count).toBe(0);
  });

  it("中途写入失败使账号、租户和会话回滚，下一次开通仍可重试", async () => {
    await pool.query("ALTER TABLE workspaces ADD CONSTRAINT provision_fixture_reject CHECK (name <> 'fixture-reject')");
    const options = { pool, bundleRoot: signedRoot };
    try {
      await expect(provisionDesktopWorkspace({ ...input, workspaceName: "fixture-reject" }, options))
        .rejects.toMatchObject({ code: "23514" });
      for (const table of ["accounts", "tenants", "workspaces", "auth_sessions", "bundle_installs", "biz_events"]) {
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, table).toBe(0);
      }
      expect(await desktopProvisionAvailable(options)).toBe(true);
    } finally {
      await pool.query("ALTER TABLE workspaces DROP CONSTRAINT provision_fixture_reject");
    }
  });

  it("保留演示升级数据且只开通一次，真实 owner 可用正常密码流程恢复会话", async () => {
    await pool.query("INSERT INTO accounts (id,email,display_name) VALUES ('legacy-email','Legacy@desktop-setup.invalid','旧账号')");
    await pool.query("INSERT INTO tenants (id,name) VALUES ('legacy-tenant','旧组织')");
    await pool.query(`INSERT INTO workspaces (id,tenant_id,name,slug,is_example)
      VALUES ('legacy-ws','legacy-tenant','旧演示工作区','workspace-new',true)`);
    const options = { pool, bundleRoot: signedRoot };
    await expect(provisionDesktopWorkspace({ ...input, email: "legacy@desktop-setup.invalid" }, options))
      .rejects.toBeInstanceOf(DesktopSetupEmailConflictError);
    expect(await desktopProvisionAvailable(options)).toBe(true);
    const attempts = await Promise.allSettled([provisionDesktopWorkspace(input, options), provisionDesktopWorkspace(input, options)]);
    const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
    const failures = attempts.filter((attempt) => attempt.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBeInstanceOf(DesktopSetupUnavailableError);
    const session = successes[0]!.value;
    expect(session.accessToken.length).toBeGreaterThan(20);
    expect(session.refreshToken.length).toBeGreaterThan(20);
    expect(session.workspaceSlug).not.toBe("workspace-new");
    expect(await desktopProvisionAvailable(options)).toBe(false);

    const recovered = await loginWithPassword({ q: (sql, params) => pool.query(sql, params), sms: new UnavailableSms() }, {
      email: input.email, password: input.password, workspaceSlug: session.workspaceSlug,
    });
    expect(recovered.identity.role).toBe("owner");
    const workspaceId = recovered.identity.workspaceId;
    expect((await pool.query("SELECT is_example,bundle_id FROM workspaces WHERE id=$1", [workspaceId])).rows[0])
      .toEqual({ is_example: false, bundle_id: "ai-pm" });
    expect((await pool.query("SELECT is_example FROM workspaces WHERE id='legacy-ws'")).rows[0].is_example).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM members WHERE account_id='legacy-email'")).rows[0].count).toBe(0);
    const ledger = (await pool.query("SELECT assets,status FROM bundle_installs WHERE workspace_id=$1", [workspaceId])).rows[0];
    expect(ledger.status).toBe("active");
    expect(ledger.assets.signer).toBe("disposable-desktop-provision-fixture");
    expect(ledger.assets.preset_ids).toHaveLength(14);
    expect(ledger.assets.fence_rule_ids).toHaveLength(14);
    expect(ledger.assets.skill_ids).toHaveLength(20);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents WHERE workspace_id=$1 AND status='ready'", [workspaceId])).rows[0].count).toBe(14);
    expect((await pool.query(`SELECT count(*)::int AS count FROM fence_rules
      WHERE workspace_id=$1 AND is_baseline AND status='active'`, [workspaceId])).rows[0].count).toBe(14);
    for (const table of ["pm_runs", "kb_collections", "kb_documents", "approvals", "triggers", "eval_questions"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, table).toBe(0);
    }
    const audit = (await pool.query("SELECT payload FROM biz_events WHERE workspace_id=$1", [workspaceId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.decision).toMatchObject({ action: "desktop.workspace.provisioned", after: { manifestDigest: ledger.assets.manifestDigest } });
    expect(JSON.stringify(audit)).not.toContain(input.password);
  });
});
