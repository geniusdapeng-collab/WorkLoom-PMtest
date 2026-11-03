import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgPmStore } from "./store.js";

describe("PM transaction connection ownership on database failures", () => {
  const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" };
  it.each([false, true])("retains the original query failure and discards the connection only when rollback fails: %s", async (rollbackFails) => {
    const queryError = new Error("synthetic PM query failure");
    const rollbackError = new Error("synthetic broken connection during rollback");
    const client = { release: vi.fn((_error?: Error) => undefined), query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM pm_runs")) throw queryError;
      if (sql === "ROLLBACK" && rollbackFails) throw rollbackError;
      return { rows: [] };
    }) };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const store = new PgPmStore(pool);
    await expect(store.list(scope, 10)).rejects.toBe(queryError);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    if (rollbackFails) expect(client.release).toHaveBeenCalledWith(rollbackError);
    else expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });
});
