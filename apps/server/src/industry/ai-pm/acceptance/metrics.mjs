/** Pure evaluation contracts and reporting: no network, database mutation or model call. */
export function wilson95(passed, total) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(passed) || passed < 0 || passed > total) {
    throw new TypeError("invalid observed count");
  }
  if (!total) return null;
  const z = 1.959963984540054;
  const p = passed / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: "Wilson 95%", total };
}

const rate = (passed, total) => total ? passed / total : null;
const logicalId = (row) => row.caseId ?? row.id;
export function observedAttempts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = logicalId(row);
    if (typeof key !== "string" || !key) throw new TypeError("evaluation row lacks a logical id");
    const attempts = groups.get(key) ?? [];
    attempts.push(row); groups.set(key, attempts);
  }
  const cases = [...groups].map(([caseId, attempts]) => ({ caseId, attempts: attempts.length,
    first: { id: attempts[0].id, passed: attempts[0].passed === true },
    latest: { id: attempts.at(-1).id, passed: attempts.at(-1).passed === true },
    operatorRepairAttempts: attempts.slice(1).filter((row) => typeof row.phase === "string" && row.phase !== "initial").length,
  }));
  const firstPassed = cases.filter((row) => row.first.passed).length;
  const latestPassed = cases.filter((row) => row.latest.passed).length;
  const passedAttempts = rows.filter((row) => row.passed === true).length;
  return {
    attempts: { total: rows.length, passed: passedAttempts, failed: rows.length - passedAttempts,
      rate: rate(passedAttempts, rows.length) },
    logicalCases: { total: cases.length, firstPassed, latestPassed,
      firstRate: rate(firstPassed, cases.length), latestRate: rate(latestPassed, cases.length),
      firstWilson95: wilson95(firstPassed, cases.length), latestWilson95: wilson95(latestPassed, cases.length) },
    operatorRepairAttempts: cases.reduce((sum, row) => sum + row.operatorRepairAttempts, 0),
    cases,
  };
}

export function classificationMetrics(rows, expected, actual, labels) {
  const matrix = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(labels.map((value) => [value, 0]))]));
  let correct = 0, unclassified = 0;
  const unknown = [];
  for (const row of rows) {
    const truth = expected(row), predicted = actual(row);
    if (!labels.includes(truth)) throw new TypeError("unknown expected label in benchmark");
    if (!labels.includes(predicted)) { unclassified++; unknown.push({ id: row.id, expected: truth, actual: predicted ?? null }); continue; }
    matrix[truth][predicted]++;
    if (truth === predicted) correct++;
  }
  const perLabel = Object.fromEntries(labels.map((label) => {
    const support = rows.filter((row) => expected(row) === label).length;
    const predicted = rows.filter((row) => actual(row) === label).length;
    const tp = matrix[label][label];
    return [label, { support, predicted, truePositive: tp, falseNegative: support - tp,
      falsePositive: predicted - tp, recall: rate(tp, support), precision: rate(tp, predicted) }];
  }));
  const recalls = Object.values(perLabel).map((row) => row.recall).filter((value) => value !== null);
  return { total: rows.length, correct, unclassified, accuracy: rate(correct, rows.length),
    accuracyWilson95: wilson95(correct, rows.length), macroRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    perLabel, matrix, unknown };
}

const modeOf = (row) => row.actualLabel ?? (row.actual?.kind === "clarify" ? "clarify" : row.actual?.mode);
const latestRows = (rows) => [...new Map(rows.map((row) => [logicalId(row), row])).values()];

/** Report this fixture's four-role chain; ancestor artifacts are supplied recursively by the service. */
export function teamPlanContract(tasks) {
  const roles = ["requirement-analyst", "dev-orchestrator", "eval-master", "doc-writer"];
  if (!Array.isArray(tasks) || tasks.length !== roles.length
    || !roles.every((role) => tasks.filter((task) => task?.presetKey === role).length === 1)) return false;
  return roles.slice(1).every((role, index) => {
    const task = tasks.find((item) => item.presetKey === role);
    const predecessor = tasks.find((item) => item.presetKey === roles[index]);
    return Array.isArray(task.dependsOn) && task.dependsOn.includes(predecessor.id);
  });
}

/** Pure budget decision; the caller still relies on the proxy's atomic reservation. */
export function intentSlotAvailable(boundary, { searchSelected = false, searchCompleted = false, searchMode } = {}) {
  // Model-planned search needs planner completion, one Search call, and the final completion.
  const searchReserve = searchSelected && !searchCompleted ? (searchMode === "direct" ? 1 : 3) : 0;
  const used = boundary?.budget?.used?.llmCalls;
  const cap = boundary?.budget?.budgets?.maxLlmCalls;
  const frozen = boundary?.budget?.frozenBy;
  const unlimited = cap === null && boundary?.budget?.schema === "workloom.pm-task-budget/v1";
  return { allowed: Number.isSafeInteger(used) && used >= 0 && (unlimited || Number.isSafeInteger(cap) && cap >= 0)
    && Array.isArray(frozen) && frozen.length === 0 && (!boundary?.budget?.exceeded || boundary.budget.exceeded.length === 0)
    && (unlimited || used < cap - searchReserve), searchReserve };
}

export function buildEvaluationMetrics(cases, session) {
  const byKind = (kind) => cases.filter((row) => row.kind === kind);
  const paidModes = byKind("intent-mode");
  const modes = latestRows(paidModes);
  const modeLabels = ["ask", "agent", "quest", "clarify"];
  const roleRows = latestRows(byKind("legacy-role-routing"));
  const roleLabels = [...new Set(roleRows.map((row) => row.expected))];
  const llmRows = modes.filter((row) => row.actual?.via === "llm");
  const fallbackRows = modes.filter((row) => row.actual?.via !== "llm");
  return {
    schema: "workloom.pm-evaluation-metrics/v2", session,
    singleEmployee: observedAttempts(byKind("single-employee")),
    teamProject: observedAttempts(byKind("team-project")),
    negativeHttp: observedAttempts(byKind("http-negative")),
    search: observedAttempts(byKind("search-function-loop")),
    intentMode: {
      paidAttemptRows: observedAttempts(paidModes),
      routeOutcome: classificationMetrics(modes, (row) => row.expected, modeOf, modeLabels),
      llmOnly: classificationMetrics(llmRows, (row) => row.expected, modeOf, modeLabels),
      // Conditional accuracy above is not end-to-end recall: timeouts and invalid
      // model decisions stay in the attempted classifier denominator as misses.
      llmAttemptOutcome: classificationMetrics(modes, (row) => row.expected,
        (row) => row.actual?.via === "llm" ? modeOf(row) : null, modeLabels),
      llmAttempts: observedAttempts(paidModes.map((row) => ({ ...row,
        passed: row.actual?.via === "llm" && modeOf(row) === row.expected }))),
      llmDecisionCoverage: { total: modes.length, classified: llmRows.length, notClassified: fallbackRows.length,
        rate: rate(llmRows.length, modes.length), basis: "latest logical classifier cases" },
      fallback: classificationMetrics(fallbackRows, (row) => row.expected, modeOf, modeLabels),
      ruleOnlyWithoutModel: classificationMetrics(latestRows(byKind("intent-rule-only")), (row) => row.expected, modeOf, modeLabels),
    },
    legacyRoleRouting: classificationMetrics(roleRows, (row) => row.expected, (row) => row.actual?.presetKey, roleLabels),
    definitions: {
      recall: "For each label: TP/(TP+FN); undefined denominators remain null. Explicitly choosing an employee is excluded from role recall.",
      achievement: "A finite observed task passed its completion/receipt/hash/declared assertions. Artifact marker checks alone are not a comprehensive semantic review.",
      attempts: "Every recorded attempt remains in its denominator; logical cases separately expose first and latest result. Operator repair is not autonomous runtime recovery.",
      modes: "LLM decisions, rule fallbacks and rule-only cases have separate denominators. A paid request followed by timeout/fallback is not an LLM classification success.",
      llmOnly: "Conditional on receiving an LLM decision; inspect llmAttemptOutcome and llmAttempts for end-to-end classifier recall including timeouts/invalid-output fallbacks as misses.",
      newTeamRouting: "The chief-pm plans an employee DAG; evaluate the actual plan and final independently checked deliverable, separately from legacy single-role routing.",
      inference: "Small synthetic samples; Wilson intervals describe observed proportions and do not establish production capability or an improvement over another release.",
    },
  };
}
