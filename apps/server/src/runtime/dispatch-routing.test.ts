/**
 * 派活岗位路由回归（N-13 第三轮实测）：
 * geo/hotel 工作区的通用 orchestrator 清单顺序不能决定派给谁——按任务语义选岗。
 */
import { describe, expect, it } from "vitest";
import { preferredDispatchPresets, preferredDispatchRulePresets } from "./dispatch-routing.js";
import roleCases from "./fixtures/pm-role-routing.json";

describe("派活岗位路由（N-13）", () => {
  it("生图/海报类目标 → 视觉岗位优先", () => {
    const list = preferredDispatchPresets({ goal: "生成一张门店周年庆促销海报", industry: "geo-growth" });
    expect(list[0]).toBe("visual-designer");
  });

  it("调价类目标 → 定价岗位优先（不再是生产编排/晨报岗位）", () => {
    const list = preferredDispatchPresets({ goal: "把雅致大床房调价到 510 元", industry: "hotel" });
    expect(list[0]).toBe("pricing-agent");
    expect(list).not.toContain("production-planner");
  });

  it("增长复盘类目标 → 增长负责人优先（geo 工作区）", () => {
    const list = preferredDispatchPresets({ goal: "整理获客漏斗周报，复盘渠道转化", industry: "geo-growth" });
    expect(list[0]).toBe("growth-lead");
  });

  it("视频类目标 → 导演/生产编排优先", () => {
    const list = preferredDispatchPresets({ goal: "做一条 30 秒抖音种草短片", industry: "ai-video" });
    expect(list.slice(0, 2)).toContain("director");
  });

  it("未命中任何语义 → 回落行业默认指挥岗位", () => {
    const list = preferredDispatchPresets({ goal: "处理一下积压的事", industry: "geo-growth" });
    expect(list[0]).toBe("growth-lead");
  });

  it.each([
    ["chief-pm", "支付故障、配色和文案错别字只有一个开发人日，请排P0/P1/P2、执行顺序、停止条件和验收证据"],
    ["requirement-analyst", "设计小团队反馈收集功能，包含三个场景、字段约束、状态流转和边界验收"],
    ["competitor-scout", "扫描竞品新版本功能变化，做来源核实与威胁评级"],
    ["data-insight", "计算访问到付费漏斗转化率并输出本周指标异动日报"],
    ["user-listener", "聚类本周用户差评、情绪和代表原声，并起草回复建议"],
    ["doc-writer", "根据已经确认的需求材料撰写完整PRD和用户可读版本说明"],
    ["industry-radar", "汇总本周AI行业政策、模型发布和投融资动态，附来源"],
    ["release-guardian", "为明天版本制作发布检查单、回滚预案和变更日志"],
    ["dev-orchestrator", "把需求拆成开发任务并实现一个可通过测试的JavaScript模块"],
    ["model-scout", "用产品评测集比较候选模型的质量、时延、成本和换型风险"],
    ["eval-master", "设计正常边界和对抗评测集，并回归badcase"],
    ["prompt-curator", "版本化生产prompt，比较新旧版回归差异并给出回滚评估"],
    ["red-teamer", "对上线候选做提示注入、越权、路径穿越和SSRF红队扫描"],
    ["knowledge-curator", "盘点知识库过期与冲突条目，并生成团队学习周刊"],
  ])("AI-PM 目标优先派给职责匹配的 %s", (employee, goal) => {
    expect(preferredDispatchPresets({ goal, industry: "ai-pm" })[0]).toBe(employee);
    expect(preferredDispatchRulePresets({ goal, industry: "ai-pm" })[0]).toBe(employee);
  });
});

describe("PM routing keeps requested deliverable ahead of background vocabulary", () => {
  it.each([
    ["doc-writer", "请根据用户反馈撰写PRD，包含核心指标、权限矩阵和发布检查"],
    ["release-guardian", "制作发布检查单，参考红队、评测集和用户反馈结论"],
    ["chief-pm", "制定项目排期，包含竞品研究、需求分析、代码实现和发布检查"],
    ["requirement-analyst", "完成需求分析，覆盖权限矩阵、提示词输入和留存指标"],
    ["eval-master", "设计评测集，覆盖模型选型、用户反馈和知识库问答"],
  ])("routes requested artifact to %s", (owner, goal) => {
    expect(preferredDispatchRulePresets({ goal, industry: "ai-pm" })[0]).toBe(owner);
  });

  it.each(roleCases.cases)("$id routes the unchanged complete goal", (item) => {
    expect(preferredDispatchPresets({ goal: item.goal, industry: "ai-pm" })[0]).toBe(item.employee);
  });

  it.each([
    ["requirement-analyst", "定义工单转交功能的字段、状态与角色约束，包含越权和重复请求验收"],
    ["competitor-scout", "对比三款协作产品的审计能力与报价，列材料依据和未知项"],
    ["industry-radar", "撰写技术动态简报，区分发布日、抓取日和未知事项"],
    ["release-guardian", "审核这次发布包并给出放行判断，材料提到越权缺陷、PR和版本说明"],
    ["dev-orchestrator", "编制研发分工与文件所有权方案，给出实现、测试和验收的依赖"],
    ["red-teamer", "针对虚构服务设计防御性测试，验证伪造角色和跨租户访问是否被拒绝"],
    ["doc-writer", "不要制作发布检查单，只需撰写用户手册，说明升级后的使用方式"],
  ])("unseen action phrasing chooses %s over contextual keywords", (employee, goal) => {
    expect(preferredDispatchRulePresets({ goal, industry: "ai-pm" })[0]).toBe(employee);
  });
});
