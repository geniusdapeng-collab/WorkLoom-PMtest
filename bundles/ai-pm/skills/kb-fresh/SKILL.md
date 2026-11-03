---
name: kb-fresh
version: 3.0.2
description: 知识库保鲜巡检——过期检测（模型版本/价格/政策失效）、冲突检测、低引用归档建议；组织知识不腐烂、不随人走。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  replacementSourceRequired: true
  conflictResolution: "scope-and-effective-date"
  lowUsageAloneDeletes: false
  updateRequiresReceipt: true
  inScopeValidStatus: active-with-scope
  crossScopeReplacement: false
---

# 知识库保鲜

## 一、何时调用
- 夜班窗口例行巡检（每周全量一次）；
- 模型代际更替、重大政策变化后专项巡检。

## 二、输入契约
- 知识库全量条目（knowledge_item）；模型版本登记表（时效比对基准）；条目引用统计。

## 三、执行步骤
1. **过期检测**：识别条目中引用的时效敏感信息（模型版本、价格、政策、工具版本），与当前现实比对，失效的标记"过期"并注明应更新为什么；
2. **冲突检测**：同一主题多条目结论矛盾时，产出冲突清单与裁决建议（附各自来源与置信度）；
3. **低引用归档建议**：长期零引用且非红线类条目，建议归档（不删除，可恢复）；
4. 处置清单提交人审，批准后执行更新/归档；
5. 知识库外发一律走 R-PM12 人审+脱敏。

6. 逐条记录知识 ID、原结论、来源日期、适用版本/地区、当前状态与替换依据；同题异版本先校准适用范围，不把范围差异误判为矛盾。
7. 低引用但关键安全/恢复条目不得自动归档；建议包含依赖该知识的文档/技能、修改影响与复核人。无可靠新来源只标待核实，旧条目与变更历史保留，批准与实际写回回执分别记录。
8. 内容有效性和元数据完整性分成两个字段：仍适用于旧版本/地区的结论是 active-with-scope（在其范围有效），缺少版本标签记 metadata_needs_scope，不标 stale/partially_stale。新版本不同结论用 related/successor 与旧条目关联；只有同一适用范围已有明确失效/取代证据才设置 replacement/过期。新版本支持某能力不证明旧版本停止维护或原能力限制失效。

## 四、边界与围栏
- 权限面：知识库读写（处置人审生效）；外发 R-PM12。
- 过期判定必须给出"当前正确值"的来源；无来源只标记不替换。

## 五、与其他技能的协作
- 上游：model-scout（模型代际信息）、industry-radar（政策动态）；
- 下游：learning-digest（保鲜结果进学习周刊）；驳回枚举 source.stale 驱动重点巡检主题。
