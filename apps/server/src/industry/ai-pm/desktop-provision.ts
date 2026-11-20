import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import {
  hashPassword, loginWithPassword, newId, suggestedWorkspaceSlug, UnavailableSms,
  type QueryFn,
} from "@workloom/base/accounts";
import {
  bundlesRoot, loadBundleUiProjection, loadVerifiedBundleManifest, loadVerifiedBundleWorkforcePresets,
} from "@workloom/base/bundles";
import { registerFeedbackEnums, validateEnumDefs, type FeedbackEnumDef } from "@workloom/base/evolve";
import { loadFencePack } from "@workloom/base/fence-engine";
import { parseSkillFrontmatter } from "@workloom/base/skills";
import { getOwnerPool } from "@workloom/db";
import { parse as parseYaml } from "yaml";
import { appendEventOn } from "../../service/events.js";
import { assertNoSecrets } from "./contract.js";
import { assertPmSkillContract } from "./skill-contracts.js";

const BUNDLE_ID = "ai-pm";
const MEMBER_NO = "MEM-001";
const INITIAL_STAGE = "discovery";
const INITIAL_STATE = `SELECT NOT EXISTS (SELECT 1 FROM workspaces WHERE is_example=false) AS available`;

export interface DesktopProvisionInput {
  displayName: string;
  tenantName: string;
  workspaceName: string;
  email: string;
  password: string;
}

interface ProvisionOptions {
  pool?: pg.Pool;
  bundleRoot?: string;
}

export class DesktopSetupUnavailableError extends Error {
  constructor(message = "当前实例无法执行桌面首次开通", options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopSetupUnavailableError";
  }
}

export class DesktopSetupEmailConflictError extends Error {
  constructor() {
    super("此邮箱已关联现有账号，请使用其他邮箱开通正式工作区");
    this.name = "DesktopSetupEmailConflictError";
  }
}

function stableManifest(root: string) {
  try {
    const manifest = loadVerifiedBundleManifest(BUNDLE_ID, root);
    if (manifest.workloom.status !== "stable" || !manifest.integrity?.signature) {
      throw new Error("行业包未进入已签名稳定发布状态");
    }
    return { manifest, integrity: manifest.integrity, signer: manifest.integrity.signature.keyId };
  } catch (cause) {
    throw new DesktopSetupUnavailableError("桌面开通需要经过验证的稳定 AI 产品经理行业包", { cause });
  }
}

function signedCatalog(root: string) {
  const { manifest, integrity, signer } = stableManifest(root);
  const { provides } = manifest.workloom;
  const readAsset = (relativePath: string) => {
    const body = readFileSync(join(root, BUNDLE_ID, relativePath));
    if (createHash("sha256").update(body).digest("hex") !== integrity.assets[relativePath]) {
      throw new Error(`行业包安装期间资产发生变更：${relativePath}`);
    }
    return body.toString("utf8");
  };

  try {
    const projection = loadBundleUiProjection(BUNDLE_ID, root);
    const hasDevelopment = projection.ui.navigation.slots.some((slot) =>
      slot.capabilityId === "ai-pm.development" && slot.route === "/development"
      && slot.clients.includes("pc") && slot.permissions.includes("ai-pm.development.read"));
    if (!hasDevelopment || projection.integrityDigest !== integrity.digest) {
      throw new Error("行业包的开发场域投影未通过校验");
    }

    const presets = loadVerifiedBundleWorkforcePresets(BUNDLE_ID, root);
    const fencePacks = provides.fences.map((asset) => loadFencePack(readAsset(asset)));
    const fences = fencePacks.flatMap((pack) => pack.rules);
    const fenceIds = new Set(fences.map((rule) => rule.rule_id));
    if (fences.length === 0 || fences.length !== fenceIds.size
      || fencePacks.some((pack) => pack.defaultLevel === "auto") || fences.some((rule) => !rule.is_baseline)) {
      throw new Error("行业营业底线围栏不完整或存在自动放行兜底");
    }

    const skills = provides.skills.map((asset) => {
      const body = readAsset(asset);
      const skill = parseSkillFrontmatter(body.replaceAll("\r\n", "\n"));
      if (!skill.name || asset !== `skills/${skill.name}/SKILL.md` || Buffer.byteLength(body) > 64 * 1024) {
        throw new Error(`技能文件与声明不匹配：${asset}`);
      }
      assertNoSecrets(body);
      assertPmSkillContract(skill.name, body);
      return { ...skill, body };
    });
    const skillNames = new Set(skills.map((skill) => skill.name));
    if (presets.length === 0 || presets.some((preset) =>
      preset.fence_bindings.some((id) => !fenceIds.has(id)) || preset.skills.some((name) => !skillNames.has(name)))) {
      throw new Error("签名岗位需要的技能或基线围栏不在同一制品中");
    }

    const stageAsset = provides.schemas.find((asset) => asset.endsWith("/stages.json"));
    const stages: { stages?: Array<{ id?: string }> } = stageAsset ? JSON.parse(readAsset(stageAsset)) : {};
    if (!stages?.stages?.some((stage) => stage.id === INITIAL_STAGE)) throw new Error("行业包缺少首次开通阶段");
    const feedback = provides.feedbackEnums
      ? validateEnumDefs((parseYaml(readAsset(provides.feedbackEnums)) as { enums: FeedbackEnumDef[] }).enums)
      : [];
    if (stableManifest(root).integrity.digest !== integrity.digest) throw new Error("行业包安装期间清单发生变更");
    return { manifest, signer, digest: integrity.digest, presets, fences, skills, feedback };
  } catch (cause) {
    throw new DesktopSetupUnavailableError("AI 产品经理行业包装配校验失败", { cause });
  }
}

export async function desktopProvisionAvailable(options: ProvisionOptions = {}): Promise<boolean> {
  const pool = options.pool ?? getOwnerPool();
  if ((await pool.query<{ available: boolean }>(INITIAL_STATE)).rows[0]?.available === false) return false;
  signedCatalog(options.bundleRoot ?? bundlesRoot());
  return true;
}

export async function provisionDesktopWorkspace(input: DesktopProvisionInput, options: ProvisionOptions = {}) {
  const catalog = signedCatalog(options.bundleRoot ?? bundlesRoot());
  const pool = options.pool ?? getOwnerPool();
  const client = await pool.connect();
  const q: QueryFn = (sql, params) => client.query(sql, params);
  const tenantId = newId("tenant");
  const workspaceId = newId("ws");
  const accountId = newId("acc");
  const installId = newId("bi");
  const email = input.email.trim();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('workloom.pmtest.desktop-provision', 0))");
    // Also serialize against writes from the existing registration API, which does not use this advisory lock.
    await client.query("LOCK TABLE accounts, tenants, workspaces IN SHARE ROW EXCLUSIVE MODE");
    if (!(await client.query<{ available: boolean }>(INITIAL_STATE)).rows[0]?.available) {
      throw new DesktopSetupUnavailableError("实例已有正式工作区，请使用现有账号登录");
    }
    if ((await q("SELECT 1 FROM accounts WHERE lower(email)=lower($1)", [email])).rows.length) {
      throw new DesktopSetupEmailConflictError();
    }
    const preferredSlug = suggestedWorkspaceSlug(input.workspaceName, "");
    const slugTaken = (await q("SELECT 1 FROM workspaces WHERE slug=$1", [preferredSlug])).rows.length > 0;
    const workspaceSlug = slugTaken ? `${preferredSlug}-${workspaceId.slice(-6)}` : preferredSlug;
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [tenantId, workspaceId]);
    await q("INSERT INTO accounts (id,email,display_name,password_hash) VALUES ($1,$2,$3,$4)",
      [accountId, email, input.displayName, hashPassword(input.password)]);
    await q("INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro')", [tenantId, input.tenantName]);
    await q(`INSERT INTO workspaces (id,tenant_id,name,slug,industry,stage,bundle_id,is_example)
      VALUES ($1,$2,$3,$4,$5,$6,$5,false)`, [workspaceId, tenantId, input.workspaceName, workspaceSlug, BUNDLE_ID, INITIAL_STAGE]);
    await q(`INSERT INTO members (id,workspace_id,member_no,name,role,account_id)
      VALUES ($1,$2,$3,$4,'owner',$5)`, [newId("mem"), workspaceId, MEMBER_NO, input.displayName, accountId]);
    await q(`INSERT INTO profiles (workspace_id,tenant_id,industry,archive)
      VALUES ($1,$2,$3,$4)`, [workspaceId, tenantId, BUNDLE_ID, JSON.stringify({
      entity_name: input.workspaceName, industry: BUNDLE_ID, stage: INITIAL_STAGE,
    })]);

    const presetIds = [];
    for (const preset of catalog.presets) {
      const id = newId("agt");
      await q(`INSERT INTO agents (id,workspace_id,preset_key,name,version,kind,readonly,fence_bindings,skills,status,meta)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)`, [id, workspaceId, preset.preset_key,
        preset.name, preset.version, preset.kind, preset.readonly, JSON.stringify(preset.fence_bindings),
        JSON.stringify(preset.skills), JSON.stringify({ description: preset.description, night_shift: preset.night_shift,
          high_risk: preset.high_risk, coverage: preset.coverage, tools: preset.tools, prompt: preset.prompt })]);
      presetIds.push(id);
    }
    const fenceIds = [];
    const fenceResult = { auto: "pass", review: "review", block: "blocked" } as const;
    for (const rule of catalog.fences) {
      const id = newId("fr");
      await q(`INSERT INTO fence_rules (id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'active',$9)`, [id, rule.rule_id, rule.version, workspaceId, rule.name,
        rule.level, JSON.stringify({ object_types: rule.objectTypes, actions: rule.actions, when: rule.when }),
        JSON.stringify({ result: fenceResult[rule.level] }), MEMBER_NO]);
      fenceIds.push(id);
    }
    const skillIds = [];
    for (const skill of catalog.skills) {
      const id = newId("skill");
      await q(`INSERT INTO skills (id,level,bundle,name,version,description,body)
        VALUES ($1,'industry',$2,$3,$4,$5,$6)`, [id, BUNDLE_ID, skill.name, skill.version, skill.description, skill.body]);
      await q(`INSERT INTO skill_installs (skill_id,workspace_id,installed_by,fence_bindings_snapshot,installed_version)
        VALUES ($1,$2,$3,'[]',$4)`, [id, workspaceId, MEMBER_NO, skill.version]);
      skillIds.push(id);
    }
    const bundle = { bundleId: BUNDLE_ID, version: catalog.manifest.version, manifestDigest: catalog.digest, signer: catalog.signer };
    await q(`INSERT INTO bundle_installs (id,workspace_id,bundle_id,assets,status,activated_at)
      VALUES ($1,$2,$3,$4,'active',now())`, [installId, workspaceId, BUNDLE_ID, JSON.stringify({
      ...bundle, preset_ids: presetIds, fence_rule_ids: fenceIds, skill_ids: skillIds,
    })]);
    await appendEventOn(client, { tenantId, workspaceId }, { id: MEMBER_NO, type: "human" }, {
      objectType: "bundle_install", objectId: installId, action: "desktop.workspace.provisioned",
      after: { ...bundle, presets: presetIds.length, fences: fenceIds.length, skills: skillIds.length },
    });
    const { accessToken, refreshToken } = await loginWithPassword({ q, sms: new UnavailableSms() }, {
      email, password: input.password, workspaceSlug,
    });
    await client.query("COMMIT");
    if (catalog.feedback.length) registerFeedbackEnums(workspaceId, catalog.feedback);
    return { accessToken, refreshToken, workspaceSlug };
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      console.error("[desktop-setup] 回滚未获得数据库确认", rollbackError instanceof Error ? rollbackError.name : "UnknownError");
    });
    throw error;
  } finally {
    client.release();
  }
}
