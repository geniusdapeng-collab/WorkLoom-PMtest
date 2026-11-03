import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgAssistantStore } from "./store.js";

describe("assistant transaction failures", () => {
  it("discards a pooled connection if rollback itself fails and keeps both errors", async () => {
    const original = new Error("fixture business query failed");
    const rollback = new Error("fixture rollback connection lost");
    const release = vi.fn();
    const client = { query: vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw rollback;
      if (sql.includes("INSERT INTO assistant_sessions")) throw original;
      return { rows: [], rowCount: 0 };
    }), release };
    const store = new PgAssistantStore({ connect: vi.fn(async () => client) } as unknown as Pool);
    const error = await store.createSession({ tenantId: "t", workspaceId: "w", memberNo: "m" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, rollback]);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("returns a successfully rolled-back connection and preserves the original failure", async () => {
    const original = new Error("fixture rejected insert");
    const release = vi.fn();
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO assistant_sessions")) throw original;
      return { rows: [], rowCount: 0 };
    }), release };
    const store = new PgAssistantStore({ connect: vi.fn(async () => client) } as unknown as Pool);
    await expect(store.createSession({ tenantId: "t", workspaceId: "w", memberNo: "m" })).rejects.toBe(original);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
