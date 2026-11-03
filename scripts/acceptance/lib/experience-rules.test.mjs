import test from "node:test";
import assert from "node:assert/strict";
import { countDecisionSignals, firstValuePassed, isFirstValueText } from "./experience-rules.mjs";

for (const productId of ["workloom-pm", "workloom-pmtest"]) {
  test(`${productId} first value uses the product delivery workbench`, () => {
    const text = "14 已就绪员工\n正在交付 0\n产物已交齐 0\n项目目标（必填）";
    assert.equal(isFirstValueText(productId, text), true);
    assert.equal(firstValuePassed({ productId, text, elapsedMs: 500, budgetMs: 20_000, decisionQuota: 7 }), true);
    assert.equal(firstValuePassed({ productId, text: "正在加载", elapsedMs: 500, budgetMs: 20_000, decisionQuota: 7 }), false);
  });
}

test("legacy first value still requires a bounded decision package", () => {
  assert.equal(countDecisionSignals("待您拍板 2 项，另有待审 1 项"), 2);
  assert.equal(firstValuePassed({ productId: "workloom-hotel", text: "待您拍板 2 项", elapsedMs: 3_000, budgetMs: 20_000, decisionQuota: 7 }), true);
  assert.equal(firstValuePassed({ productId: "workloom-hotel", text: "暂无待决事项", elapsedMs: 3_000, budgetMs: 20_000, decisionQuota: 7 }), false);
  assert.equal(firstValuePassed({ productId: "workloom-hotel", text: "待您拍板 2 项", elapsedMs: 21_000, budgetMs: 20_000, decisionQuota: 7 }), false);
});
