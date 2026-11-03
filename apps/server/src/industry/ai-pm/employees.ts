import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assemblePreset, type AssembledPreset } from "@workloom/runtime";
import { bundlesRoot, loadVerifiedBundleManifest, loadVerifiedBundleWorkforcePresets } from "@workloom/base/bundles";
import { getAppPool } from "@workloom/db";
import { resolveWorkspaceActiveBundle } from "../../service/active-bundle.js";
import { assertNoSecrets } from "./contract.js";
import { PmError, type PmAssetBinding, type PmEmployee, type PmScope } from "./types.js";
import type { PmStore } from "./store.js";
import { assertPmSkillContract } from "./skill-contracts.js";
import { snapshotPmAssetBinding } from "./asset-binding.js";

export interface PmEmployeeCatalog {
  list(scope: PmScope): Promise<PmEmployee[]>;
  assemble(scope: PmScope, presetKey: string, goal: string): Promise<{ preset: AssembledPreset; skillText: string; assetBinding?: PmAssetBinding }>;
}

/** The package identity, asset digest, current DB readiness and individual assembly must all agree. */
export function createPmEmployeeCatalog(store: Pick<PmStore, "employees">): PmEmployeeCatalog {
  const manifestDigest = (manifest: unknown) => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  async function definitions(scope: PmScope) {
    const active = await resolveWorkspaceActiveBundle(scope.workspaceId);
    if (active.state !== "ready" || active.bundleId !== "ai-pm") {
      throw new PmError("PM_BUNDLE_NOT_ACTIVE", "当前工作区未装配通过校验的AI产品经理行业包", 409);
    }
    const root = bundlesRoot();
    const manifest = loadVerifiedBundleManifest("ai-pm", root);
    const assets = loadVerifiedBundleWorkforcePresets("ai-pm", root);
    if (manifestDigest(loadVerifiedBundleManifest("ai-pm", root)) !== manifestDigest(manifest)) {
      throw new PmError("PM_BUNDLE_ASSET_DRIFT", "装配期间行业包版本发生变化，未绑定不一致来源", 409);
    }
    return { assets, manifest, root };
  }
  return {
    async list(scope) {
      const [{ assets }, ready] = await Promise.all([definitions(scope), store.employees(scope)]);
      const readyKeys = new Set(ready.map((employee) => employee.presetKey));
      return assets.filter((asset) => readyKeys.has(asset.preset_key)).map((asset) => ({
        presetKey: asset.preset_key, name: asset.name, description: asset.description,
      }));
    },
    async assemble(scope, presetKey, goal) {
      const { assets, manifest, root } = await definitions(scope);
      const asset = assets.find((item) => item.preset_key === presetKey);
      if (!asset) throw new PmError("EMPLOYEE_NOT_READY", "该员工不属于当前已验证的AI产品经理行业包", 409);
      const preset = await assemblePreset(getAppPool(), scope, { workspaceId: scope.workspaceId, presetKey, goal });
      const declared = new Map(asset.tools.map((tool) => [tool.name, tool.access]));
      if (asset.readonly || preset.presetKey !== asset.preset_key || preset.version !== asset.version
        || preset.highRisk !== asset.high_risk || asset.fence_bindings.some((binding) => !preset.fenceBindings.includes(binding))
        || preset.tools.length !== declared.size || new Set(preset.tools.map((tool) => tool.name)).size !== declared.size
        || preset.tools.some((tool) => declared.get(tool.name) !== tool.access)) {
        throw new PmError("EMPLOYEE_ASSET_DRIFT", "员工运行态与已验证的岗位工具资产不一致，请重新装配", 409);
      }
      if (manifestDigest(loadVerifiedBundleManifest("ai-pm", root)) !== manifestDigest(manifest)) {
        throw new PmError("PM_BUNDLE_ASSET_DRIFT", "员工装配期间行业包版本发生变化，未静默换用新来源", 409);
      }
      const skills: string[] = [];
      const skillAssets: Array<{ name: string; path: string; sha256: string }> = [];
      for (const name of asset.skills) {
        const relative = `skills/${name}/SKILL.md`;
        if (!manifest.workloom.provides.skills.includes(relative)) throw new PmError("SKILL_NOT_DECLARED", "员工技能没有进入行业包声明索引", 409);
        const text = await readFile(join(root, "ai-pm", relative), "utf8");
        if (Buffer.byteLength(text) > 64 * 1024 || createHash("sha256").update(text).digest("hex") !== manifest.integrity?.assets[relative]) {
          throw new PmError("SKILL_ASSET_DRIFT", "员工技能正文与已验证摘要不一致", 409);
        }
        assertNoSecrets(text); assertPmSkillContract(name, text); skills.push(`## ${name}\n${text}`);
        skillAssets.push({ name, path: relative, sha256: manifest.integrity.assets[relative]! });
      }
      // Source prompts are integrity-checked; mutable database prompt text cannot silently replace them.
      preset.prompt = asset.prompt;
      const skillText = skills.join("\n\n");
      const presetPath = manifest.workloom.provides.presets.find((path) => path.endsWith(`/${presetKey}.yml`));
      if (!presetPath || !manifest.integrity?.assets[presetPath]) throw new PmError("PRESET_ASSET_DRIFT", "岗位源摘要缺失，未装配员工", 409);
      const assetBinding = snapshotPmAssetBinding({ schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: manifest.version,
        manifestSha256: manifestDigest(manifest), bundleIntegrityDigest: manifest.integrity.digest,
        presetKey, presetSha256: manifest.integrity.assets[presetPath],
        skillTextSha256: createHash("sha256").update(skillText, "utf8").digest("hex"), skills: skillAssets });
      return { preset, skillText, assetBinding };
    },
  };
}
