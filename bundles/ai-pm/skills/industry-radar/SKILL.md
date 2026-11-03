---
name: industry-radar
version: 3.0.2
description: 四路信号情报聚合（竞品/模型发布/工具链/政策）+ 去重 + LLM 摘要 + 来源与置信度标注；模型发布信号自动联动 model-scout 试跑。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  primarySourceRequired: true
  publishedAndFetchedTimeRequired: true
  syndicatedSources: "one-origin"
  failedFetch: "unknown-not-empty"
  reportDate: separate-from-source-times
  missingBehavior: unknown-not-negative
---

# 行业情报聚合（四路信号版）

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 夜班窗口拉取四路订阅源：竞品动态 / 模型发布 / 工具链演进 / 行业政策；
2. 去重聚类（标题相似度+时间窗）；
3. LLM 三条摘要，每条附来源链接、时间与**置信度**（A/B/C 级，C 级仅作线索）；
4. **模型发布信号自动联动 model-scout**：触发换型触发器判断与本产品场景试跑；
5. 时效敏感信息（模型版本/价格/政策）标记保鲜期限，供 kb-fresh 巡检。

6. 每条记录原始发布方、原文 URL、事件发生/发布日期、抓取时间、适用地区/版本与置信度；聚合转载追到同一原始来源，只算一个证据，避免多源假象。
7. 区分已发布、预告、传闻及正式生效；抓取失败与当期零条目分列。先写事实，再写对本产品的影响假设、责任岗位、验证动作和保鲜期限，不依据标题直接触发付费试跑。
8. 报告生成日、来源发布日、事件生效日和材料抓取日是独立字段；只拿到来源快照时不把抓取日当本报告日期，报告日期未知就省略或标未提供。材料没说明错误码、退化行为或能力时一律未知，不能从缺字段推断“非报错/不会失败/无变化”；摘要标题与待核实清单也必须一致。

## 四、边界与围栏
- 权限面：联网只读；情报写库（L0/L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」；厂商宣称数据标注置信度，不作决策依据。

## 五、与其他技能的协作
- 产出进晨报素材池与学习周刊原料池；异常与高威胁项挂审批台（review-console）；
- 模型信号 → model-scout（试跑）；政策/价格变动 → kb-fresh（知识保鲜专项巡检）。
