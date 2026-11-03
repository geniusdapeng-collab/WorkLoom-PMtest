/**
 * PM evaluation accounting. Model capacity is deliberately absent from this file.
 * Forecasts reserve concurrent work; a measured settlement replaces its forecast.
 * A forecast is not a hard upper bound on a provider's final usage. An overrun is
 * recorded in full and prevents the next request. Unknown outcomes retain their
 * reservation and freeze the run; no automatic retry or ledger reset is allowed.
 */
import { appendFileSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const PM_TASK_BUDGET_SCHEMA = "workloom.pm-task-budget/v1";
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
const integer = (value) => finite(value) && Number.isSafeInteger(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function normalizePmTaskBudget(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PM taskBudget must be an object");
  const fields = ["maxCalls", "maxActualTokens", "hardTotalTokens", "maxCostCny", "maxWallClockMin"];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unknown PM taskBudget field");
  return Object.fromEntries(fields.map((key) => {
    const limit = value[key] ?? null;
    if (limit !== null && (!(key === "maxCalls" || key === "maxActualTokens" || key === "hardTotalTokens" ? integer(limit) : finite(limit)))) throw new Error(`Invalid PM taskBudget.${key}`);
    return [key, limit];
  }));
}

export function createPmTaskBudget({ outDir, runId, taskBudget = {}, pricing = { llmCnyPer1kTokens: 0.02 }, now = Date.now, lockTimeoutMs = 5000 } = {}) {
  if (!text(outDir) || !text(runId)) throw new Error("PM accounting requires an evidence directory and runId");
  if (!finite(pricing.llmCnyPer1kTokens) || Object.keys(pricing).some((key) => key !== "llmCnyPer1kTokens")) throw new Error("Invalid PM frozen accounting price");
  if (!integer(lockTimeoutMs)) throw new Error("Invalid PM transaction lock timeout");
  const limits = normalizePmTaskBudget(taskBudget);
  const frozenPricing = { llmCnyPer1kTokens: pricing.llmCnyPer1kTokens };
  const ledgerPath = join(outDir, "budget-ledger.jsonl");
  const lockPath = `${ledgerPath}.lock`;
  mkdirSync(outDir, { recursive: true });
  if (lstatSync(outDir).isSymbolicLink() || !lstatSync(outDir).isDirectory()) throw new Error("PM evidence directory must be an ordinary directory");
  const estimate = (tokens) => tokens / 1000 * frozenPricing.llmCnyPer1kTokens;
  function locked(operation) {
    const until = Date.now() + lockTimeoutMs;
    while (true) {
      try { mkdirSync(lockPath); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= until) throw new Error("PM budget transaction lock is unavailable; no paid request is authorized");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return operation(); } finally { rmSync(lockPath, { recursive: true }); }
  }
  function record(event) {
    const fd = openSync(ledgerPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify({ schema: PM_TASK_BUDGET_SCHEMA, runId, at: new Date(now()).toISOString(), ...event })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  const identity = (row) => text(row.taskId) && text(row.reservationId) && row.kind === "llm";
  function replay() {
    if (existsSync(ledgerPath)) {
      const stat = lstatSync(ledgerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(stat.mode & 0o444) || !(stat.mode & 0o222)) throw new Error("PM ledger must be an independent readable/writable regular file");
    }
    const raw = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    if (raw && !raw.endsWith("\n")) throw new Error("PM ledger has an incomplete final transaction; paid I/O denied");
    const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const state = { init: null, reservations: new Map(), frozen: [], blocked: [] };
    for (const row of rows) {
      if (row.schema !== PM_TASK_BUDGET_SCHEMA || row.runId !== runId || !Number.isFinite(Date.parse(row.at))) throw new Error("PM ledger schema/run identity is incompatible; old evidence cannot be reset or mixed");
      if (row.event === "budget-init") {
        if (state.init || state.reservations.size || !integer(row.startedAt) || row.startedAt > now() || !equal(row.taskBudget, limits) || !equal(row.pricing, frozenPricing)) throw new Error("PM ledger initialization or frozen policy does not match");
        state.init = row;
        continue;
      }
      if (!state.init) throw new Error("PM ledger is missing initialization");
      if (row.event === "reserve") {
        if (!identity(row) || !integer(row.tokens) || !integer(row.hardHoldTokens) || !finite(row.estimateCny) || !text(row.requestSha256) || state.reservations.has(row.reservationId)) throw new Error("PM reservation is invalid or duplicated");
        state.reservations.set(row.reservationId, { ...row, settlement: null });
      } else if (row.event === "commit") {
        const prior = state.reservations.get(row.reservationId);
        if (!identity(row) || !prior || prior.taskId !== row.taskId || prior.settlement || !integer(row.tokens) || !integer(row.calls) || row.calls > 1 || typeof row.measured !== "boolean" || !finite(row.costCny) || !["ok", "failed", "blocked"].includes(row.status)) throw new Error("PM settlement chain is invalid");
        prior.settlement = row;
      } else if (row.event === "usage-unverified") {
        if (!text(row.taskId) || !text(row.reason)) throw new Error("PM freeze event lacks a reason");
        state.frozen.push({ taskId: row.taskId, reason: row.reason });
      } else if (row.event === "reserve-denied" || row.event === "commit-denied") {
        if (!text(row.reason)) throw new Error("PM denial event lacks a reason");
        state.blocked.push({ taskId: row.taskId, reservationId: row.reservationId, reason: row.reason });
      } else throw new Error("PM ledger contains an unknown event");
    }
    return state;
  }
  locked(() => { if (!replay().init) record({ event: "budget-init", startedAt: now(), taskBudget: limits, pricing: frozenPricing }); });
  const empty = () => ({ llmCalls: 0, llmTokens: 0, costCny: 0 });
  const add = (target, source) => { for (const key of Object.keys(target)) target[key] += source[key]; };
  function usage(state) {
    const result = { used: empty(), actual: empty(), pending: empty(), unmeasured: empty() };
    for (const reservation of state.reservations.values()) {
      const settlement = reservation.settlement;
      const forecast = { llmCalls: 1, llmTokens: reservation.tokens, costCny: reservation.estimateCny };
      const item = settlement?.measured ? { llmCalls: settlement.calls, llmTokens: settlement.tokens, costCny: settlement.costCny } : forecast;
      add(result.used, item);
      add(settlement?.measured ? result.actual : settlement ? result.unmeasured : result.pending, item);
    }
    for (const group of Object.values(result)) if (!integer(group.llmCalls) || !integer(group.llmTokens) || !finite(group.costCny)) throw new Error("PM aggregate accounting exceeds safe numeric range");
    return result;
  }
  const frozenBy = (state) => [...state.frozen, ...[...state.reservations.values()].filter((row) => row.settlement?.measured === false).map((row) => ({ taskId: row.taskId, reservationId: row.reservationId, reason: row.settlement.detail || "Provider usage is unknown" }))];
  const hardTokensUsed = (state) => {
    const value = [...state.reservations.values()].reduce((sum, row) => sum + (row.settlement?.measured ? row.settlement.tokens : row.hardHoldTokens), 0);
    if (!integer(value)) throw new Error("PM hard quota accounting exceeds safe numeric range");
    return value;
  };
  const exceeded = (used) => [["llmCalls", "maxCalls"], ["llmTokens", "maxActualTokens"], ["costCny", "maxCostCny"]].filter(([key, limit]) => limits[limit] !== null && used[key] > limits[limit]).map(([key]) => key);
  function deny(event, args, reason) {
    record({ event: `${event}-denied`, taskId: args.taskId, reservationId: args.reservationId, reason });
    return { allowed: false, committed: false, reason };
  }
  function reserve({ taskId, reservationId = taskId, kind = "llm", tokens = 0, hardHoldTokens = tokens, estimateCny = estimate(tokens), requestSha256 = "unspecified", detail = "" } = {}) {
    return locked(() => {
      const args = { taskId, reservationId, kind, tokens, hardHoldTokens, estimateCny, requestSha256 };
      if (!identity(args) || !integer(tokens) || !integer(hardHoldTokens) || !finite(estimateCny) || !text(requestSha256)) return deny("reserve", args, "Invalid PM forecast reservation");
      const state = replay();
      const prior = state.reservations.get(reservationId);
      if (prior) {
        if (!["taskId", "kind", "tokens", "hardHoldTokens", "estimateCny", "requestSha256"].every((key) => prior[key] === args[key])) return deny("reserve", args, "Idempotency key conflicts with a prior request");
        return { allowed: true, duplicate: true, settled: Boolean(prior.settlement), reservationId, estimateCny };
      }
      if (frozenBy(state).length) return deny("reserve", args, "Prior usage is unknown; paid calls are frozen");
      if (limits.maxWallClockMin !== null && (now() - state.init.startedAt) / 60000 >= limits.maxWallClockMin) return deny("reserve", args, "PM task wall-clock limit reached");
      if (limits.hardTotalTokens !== null && hardTokensUsed(state) + hardHoldTokens > limits.hardTotalTokens) return deny("reserve", args, `PM hard total-token quota cannot hold ${hardHoldTokens} tokens; model output capacity is unchanged`);
      const projected = usage(state).used;
      add(projected, { llmCalls: 1, llmTokens: tokens, costCny: estimateCny });
      const over = exceeded(projected);
      if (over.length) return deny("reserve", args, `PM task forecast exceeds ${over.join(", ")}; model output capacity is unchanged`);
      record({ event: "reserve", ...args, detail });
      return { allowed: true, duplicate: false, reservationId, estimateCny };
    });
  }
  function commit({ taskId, reservationId = taskId, kind = "llm", tokens = 0, calls = 1, costCny = null, measured = false, status = "ok", detail = "" } = {}) {
    return locked(() => {
      const args = { taskId, reservationId, kind, tokens, calls, costCny: costCny ?? estimate(tokens), measured, status };
      if (!identity(args) || !integer(tokens) || !integer(calls) || calls > 1 || !finite(args.costCny) || typeof measured !== "boolean" || !["ok", "failed", "blocked"].includes(status)) return deny("commit", args, "Invalid PM settlement; forecast remains reserved");
      const state = replay();
      const prior = state.reservations.get(reservationId);
      if (!prior || prior.taskId !== taskId || prior.kind !== kind) return deny("commit", args, "No matching PM reservation exists");
      if (prior.settlement) {
        if (!["tokens", "calls", "costCny", "measured", "status"].every((key) => prior.settlement[key] === args[key])) return deny("commit", args, "Conflicting PM settlement cannot replace prior evidence");
        return { committed: true, duplicate: true, reservationId, exceeded: exceeded(usage(state).used) };
      }
      record({ event: "commit", ...args, detail });
      if (measured && limits.hardTotalTokens !== null && tokens > prior.hardHoldTokens) record({ event: "usage-unverified", taskId, reason: "Provider usage exceeded the reserved hard token bound; reconcile before another paid call" });
      return { committed: true, duplicate: false, reservationId, exceeded: exceeded(usage(replay()).used) };
    });
  }
  function freeze({ taskId, reason }) {
    if (!text(taskId) || !text(reason)) throw new Error("PM freeze requires a task and reason");
    return locked(() => {
      if (replay().frozen.some((row) => row.taskId === taskId && row.reason === reason)) return { frozen: true, duplicate: true };
      record({ event: "usage-unverified", taskId, reason });
      return { frozen: true, duplicate: false };
    });
  }
  function snapshot(state) {
    const totals = usage(state);
    const frozen = frozenBy(state);
    return { schema: PM_TASK_BUDGET_SCHEMA, runId, taskBudget: limits,
      budgets: { maxLlmCalls: limits.maxCalls, maxLlmTokens: limits.maxActualTokens, maxCostCny: limits.maxCostCny, maxWallClockMin: limits.maxWallClockMin },
      pricing: frozenPricing, startedAt: state.init.startedAt,
      costBasis: { used: "Measured usage replaces forecast; outstanding/unknown requests retain forecast. Cost is frozen-rate estimate, not invoice.", actual: "Measured tokens at frozen accounting rate; non-model operations may use a separately disclosed fixed estimate.", invoiced: null },
      ...totals, hardQuota: { limitTokens: limits.hardTotalTokens, usedOrHeldTokens: hardTokensUsed(state), policy: "Measured actual tokens plus full-input/legal-output holds for pending or unknown requests" },
      used: { ...totals.used, wallClockMin: (now() - state.init.startedAt) / 60000 },
      measurementComplete: !frozen.length && [...state.reservations.values()].every((row) => row.settlement?.measured === true),
      frozenBy: frozen, reservations: [...state.reservations.values()].map((row) => ({ reservationId: row.reservationId, taskId: row.taskId, kind: row.kind, tokens: row.tokens, hardHoldTokens: row.hardHoldTokens, estimateCny: row.estimateCny, requestSha256: row.requestSha256, status: row.settlement?.status ?? "pending", settlement: row.settlement })),
      exceeded: exceeded(totals.used), blocked: state.blocked, ledger: ledgerPath,
      admission: "maxActualTokens/maxCostCny are rolling forecast thresholds, not hard spend guarantees. hardTotalTokens holds full input plus legal output before send and settles actual once. maxCalls is a hard physical-call count." };
  }
  const summary = () => locked(() => snapshot(replay()));
  function persist() {
    return locked(() => {
      const value = snapshot(replay());
      const temporary = join(outDir, `.pm-budget-summary-${process.pid}-${randomUUID()}.tmp`);
      try { writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temporary, join(outDir, "budget-summary.json")); }
      finally { rmSync(temporary, { force: true }); }
      return value;
    });
  }
  return { reserve, commit, freeze, summary, persist, ledgerPath, pricing: frozenPricing };
}
