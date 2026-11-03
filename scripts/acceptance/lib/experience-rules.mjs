export const isPmProduct = (productId) => productId === "workloom-pm" || productId === "workloom-pmtest";

export function isFirstValueText(productId, text) {
  if (isPmProduct(productId)) {
    return /已就绪员工[\s\S]*正在交付|团队已就位[\s\S]*项目目标/.test(text);
  }
  return /晨报|经营简报|待决|决策包|待您拍板/.test(text);
}

export function countDecisionSignals(text) {
  const actionable = String(text ?? "")
    .replace(/暂无(?:待决|待办|待审)事项?/g, "")
    .replace(/无待决事项?/g, "")
    .replace(/待您拍板\s*0\s*项/g, "");
  return (actionable.match(/待决|待我(拍板|审批)|待您拍板|需你拍板|待审/g) ?? []).length;
}

export function firstValuePassed({ productId, text, elapsedMs, budgetMs, decisionQuota }) {
  if (!text || elapsedMs > budgetMs) return false;
  if (isPmProduct(productId)) return /已就绪员工/.test(text) && /项目目标/.test(text);
  const decisions = countDecisionSignals(text);
  return decisions > 0 && decisions <= decisionQuota * 3;
}
