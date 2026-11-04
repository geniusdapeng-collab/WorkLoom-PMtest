import { createHash, randomUUID } from "node:crypto";
import { createDeepSeekTools, type DeepSeekToolsConfig } from "@workloom/base/model-router";
import { getAppPool, withWorkspace } from "@workloom/db";
import { assertNoSecrets } from "./contract.js";
import { lockActivePmRunLease } from "./store.js";
import { PmError, type PmScope } from "./types.js";

export interface SearchReceipt {
  provider: "deepseek";
  querySha256: string;
  search: { resultCount: number };
  fetch: { url: string; title: string; contentSha256: string; excerpt: string };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function publicResult(value: unknown): string | undefined {
  if (!record(value) || typeof value.url !== "string") return;
  try {
    const url = new URL(value.url);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { return; }
}

async function liveSearch(query: string, signal: AbortSignal, config: DeepSeekToolsConfig): Promise<SearchReceipt> {
  const [search, fetchPage] = createDeepSeekTools(config);
  if (!search || !fetchPage) throw new PmError("SEARCH_NOT_CONFIGURED", "DeepSeek 公共搜索工具未就绪", 503);
  const results = await search.execute({ query, count: 5, need_content: false }, { signal });
  if (!record(results) || !Array.isArray(results.results)) throw new PmError("SEARCH_PROTOCOL", "DeepSeek 搜索结果协议异常", 502);
  const url = results.results.map(publicResult).find((candidate): candidate is string => Boolean(candidate));
  if (!url) throw new PmError("SEARCH_EVIDENCE_MISSING", "DeepSeek 未返回可抓取的公开证据", 502);
  const page = await fetchPage.execute({ url }, { signal });
  if (!record(page) || typeof page.content !== "string" || !page.content.trim()
    || typeof page.title !== "string" || page.url !== url) {
    throw new PmError("SEARCH_EVIDENCE_MISSING", "DeepSeek 未返回与来源绑定的正文", 502);
  }
  const receipt: SearchReceipt = {
    provider: "deepseek",
    querySha256: digest(query),
    search: { resultCount: results.results.length },
    fetch: { url, title: page.title, contentSha256: digest(page.content), excerpt: Array.from(page.content).slice(0, 3500).join("") },
  };
  assertNoSecrets(receipt);
  return receipt;
}

class SettledPmSearch extends Error {
  constructor(readonly evidence: SearchReceipt) { super("已有同一检索的持久化回执"); }
}

export async function readPmSearchReservation(scope: PmScope, runId: string): Promise<{ evidence: SearchReceipt | null } | null> {
  return withWorkspace(getAppPool(), scope, async (_db, client) => {
    const result = await client.query<{ evidence: SearchReceipt | null }>(
      `SELECT evidence FROM pm_superagent_search
       WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND blocked_before_send_at IS NULL`,
      [runId, scope.tenantId, scope.workspaceId],
    );
    return result.rows[0] ?? null;
  });
}

export async function readPmSearchEvidence(scope: PmScope, runId: string): Promise<SearchReceipt | null> {
  return (await readPmSearchReservation(scope, runId))?.evidence ?? null;
}

function searchTransport(): Pick<DeepSeekToolsConfig, "apiKey" | "fetch"> {
  const pmBase = process.env.PM_MODEL_BASE_URL?.trim();
  const rawBase = pmBase || process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const base = new URL(rawBase);
  const local = base.protocol === "http:" && base.hostname === "127.0.0.1" && base.port
    && base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password;
  const modelKey = (pmBase ? process.env.PM_MODEL_API_KEY : process.env.LLM_API_KEY)?.trim();
  if (local && process.env.PM_SEARCH_USE_LOOPBACK === "1" && modelKey) {
    return {
      apiKey: modelKey,
      fetch: (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname !== "/v1/tools/search" && pathname !== "/v1/tools/fetch") throw new Error("Unexpected search transport path");
        return fetch(new URL(pathname, base.origin), init);
      },
    };
  }
  if (base.origin === "https://api.deepseek.com" && !base.username && !base.password) {
    const key = process.env.PM_MODEL_API_KEY?.trim() || process.env.LLM_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
    if (key) return { apiKey: key };
  }
  throw new PmError("SEARCH_NOT_CONFIGURED", "公开搜索需要 DeepSeek 官方连接或显式启用的本机预算代理", 503);
}

/** A reservation survives a crash or ambiguous vendor response. Resume can reuse settled evidence only. */
export async function collectPmSearchEvidence(scope: PmScope, runId: string, owner: string, query: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<SearchReceipt> {
  assertNoSecrets(query);
  signal.throwIfAborted();
  const transport = searchTransport();
  await authorize();
  const querySha256 = digest(query);
  const attemptId = randomUUID();
  const keys = [runId, scope.tenantId, scope.workspaceId] as const;
  let reservationCommitted = false;
  let transportStarted = false;
  let toolSignal: AbortSignal | undefined;
  let receipt: SearchReceipt;
  try {
    receipt = await liveSearch(query, signal, {
      ...transport, timeoutMs: 60_000,
      beforeRequest: ({ signal: requestSignal }) => { toolSignal = requestSignal; return authorize(); },
      fetch: (url, init) => {
        transportStarted = true;
        return (transport.fetch ?? fetch)(url, init);
      },
      beforeDispatch: async ({ operation, signal: requestSignal }) => {
        await withWorkspace(getAppPool(), scope, async (_db, client) => {
          if (!await lockActivePmRunLease(client, scope, runId, owner)) throw new PmError("RUN_LEASE_LOST", "搜索前执行租约已失效", 409);
          requestSignal.throwIfAborted();
          if (operation !== "search") return;
          // Admission belongs to the last pre-dispatch boundary. A denied
          // authorization or expired lease must not create a billable ambiguity.
          const inserted = await client.query(
            `INSERT INTO pm_superagent_search(run_id, tenant_id, workspace_id, query_sha256, attempt_id) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT DO NOTHING RETURNING run_id`,
            [...keys, querySha256, attemptId],
          );
          requestSignal.throwIfAborted();
          if (inserted.rowCount === 1) return;
          const { rows: [prior] } = await client.query<{ query_sha256: string; evidence: SearchReceipt | null }>(
            `SELECT query_sha256, evidence FROM pm_superagent_search
             WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND blocked_before_send_at IS NULL`, [...keys],
          );
          if (prior?.query_sha256 === querySha256 && prior.evidence) throw new SettledPmSearch(prior.evidence);
          throw new PmError("SEARCH_RECEIPT_UNSETTLED", "此前搜索尚无已核验回执，已冻结重复调用", 409);
        });
        if (operation === "search") reservationCommitted = true;
      },
    });
  } catch (error) {
    // Only an acknowledged reservation from this invocation can be closed as
    // no-send. An uncertain commit or any entered transport remains pending.
    if (reservationCommitted && !transportStarted) {
      try {
        await withWorkspace(getAppPool(), scope, async (_db, client) => {
          const closed = await client.query(
            `UPDATE pm_superagent_search SET blocked_before_send_at=clock_timestamp()
             WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND query_sha256=$4 AND attempt_id=$5
               AND completed_at IS NULL AND blocked_before_send_at IS NULL`, [...keys, querySha256, attemptId]);
          if (closed.rowCount !== 1) throw new Error("Missing original pending search reservation");
        });
      } catch {
        throw new PmError("SEARCH_RECEIPT_UNSETTLED", "搜索未发送，但本次预留未能可靠结算，已阻止重复调用", 503);
      }
      signal.throwIfAborted();
      throw new PmError("INTERRUPTED", "搜索在发送前中止，已结算未发送记录，可显式恢复", 504);
    }
    signal.throwIfAborted();
    // A deadline raised by the connector before COMMIT/transport is distinct
    // from a database exception whose COMMIT outcome may be unknown.
    if (!transportStarted && toolSignal?.aborted && error === toolSignal.reason) {
      throw new PmError("INTERRUPTED", "搜索在发送前中止，可显式恢复", 504);
    }
    if (error instanceof SettledPmSearch) return error.evidence;
    if (error instanceof PmError) throw error;
    throw new PmError("SEARCH_RECEIPT_UNSETTLED", "DeepSeek 搜索或抓取未取得完整回执，已保留执行记录", 502);
  }
  await withWorkspace(getAppPool(), scope, async (_db, client) => {
    const result = await client.query(
      `UPDATE pm_superagent_search SET evidence=$4::jsonb,completed_at=now()
       WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND query_sha256=$5 AND attempt_id=$6
         AND completed_at IS NULL AND blocked_before_send_at IS NULL`,
      [...keys, JSON.stringify(receipt), querySha256, attemptId],
    );
    if (result.rowCount !== 1) throw new PmError("SEARCH_RECEIPT_UNSETTLED", "DeepSeek 搜索回执未能可靠落库", 503);
  });
  signal.throwIfAborted();
  return receipt;
}
