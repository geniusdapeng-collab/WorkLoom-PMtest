import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { executeDesktopTurn, type DesktopTurnEvent } from "./dsh-desktop-turn.mjs";

type ResponseMode = "completed" | "wrong-session" | "wrong-redirect" | "wrong-rpc" | "missing-final" | "missing-tool-result" | "foreign-prompt" | "failed-turn" | "gap" | "pending";
const input = "生成可验证的交付";
const fakeCookie = () => `dsh-auth-${randomBytes(32).toString("base64url")}=v2.c2Vzc2lvbg.${randomBytes(32).toString("base64url")}`;

async function fixture(mode: ResponseMode) {
  const token = randomBytes(32).toString("base64url");
  const browserCookie = fakeCookie();
  const methods: string[] = [];
  const modelTool = "write_file";
  let promptReceived!: () => void;
  const prompted = new Promise<void>((resolve) => { promptReceived = resolve; });
  let journal: { type: "event"; event: { type: string; seq: number; data: unknown; surfaceOp?: "append" } }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === `/?token=${token}`) {
      res.writeHead(303, { location: mode === "wrong-redirect" ? "//localhost/other" : "./", "set-cookie": `${browserCookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { type, rpcId, method, payload } = JSON.parse(Buffer.concat(chunks).toString());
    if (type !== "client-request" || req.method !== "POST" || req.url !== `/api/${method}` ||
      req.headers.cookie !== browserCookie || req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    methods.push(method);
    const sent = payload.args.request;
    let value;
    switch (method) {
      case "session/create":
        value = { sessionId: mode === "wrong-session" ? "different-session" : sent.sessionId };
        break;
      case "session/prompt": {
        const records = [
          { type: "turn/start", data: { turn: 1 } },
          { type: "user/message", data: {
            source: { kind: "user", rpcId: mode === "foreign-prompt" ? "foreign-request" : sent.requestId },
            content: sent.content,
          } },
          { type: "tool/call", data: { callId: "model-call", name: modelTool, arguments: "{}" } },
          ...(mode === "missing-tool-result" ? [] : [{ type: "tool/result", surfaceOp: "append" as const,
            data: { message: { toolCallId: "model-call", isError: false, content: [] } } }]),
          ...(mode === "missing-final" ? [] : [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "真实终态" }] } } }]),
          { type: "turn/end", data: { turn: 1, reason: { kind: mode === "failed-turn" ? "error" : "completed" } } },
        ];
        journal = (mode === "pending" ? records.slice(0, 2) : records).map((event, seq) => ({
          type: "event",
          event: { ...event, seq: mode === "gap" && seq === 2 ? seq + 1 : seq },
        }));
        value = { accepted: true };
        promptReceived();
        break;
      }
      case "session/projections": value = { asOfSeq: journal.length - 1 }; break;
      case "session/page": value = { records: journal, hasMore: false }; break;
      case "session/cancel": value = { accepted: true }; break;
      default:
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rpcId: mode === "wrong-rpc" ? "foreign-envelope" : rpcId, result: { ok: true, value } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to listen");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/?token=${token}`, methods, prompted,
    close() { return new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); },
  };
}

describe("DSH Desktop single-turn transport", () => {
  it("uses durable turn records and preserves tool names and correlated receipts", async () => {
    const host = await fixture("completed");
    try {
      const observed: DesktopTurnEvent[] = [];
      const { events } = await executeDesktopTurn({
        url: host.url, workspace: tmpdir(), prompt: input, onEvent: (event) => { observed.push(event); },
      });
      expect(events).toEqual(observed);
      expect(events).toEqual([
        { type: "session", sessionId: expect.stringMatching(/^[a-f0-9-]{36}$/u) },
        { type: "tool_call", tool: "write_file", callId: "model-call" },
        { type: "tool_result", status: "completed", callId: "model-call" },
        { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
        { type: "final", text: "真实终态" },
      ]);
    } finally { await host.close(); }
  });

  it.each([
    ["wrong-session", "DSH_PROTOCOL", false],
    ["wrong-redirect", "DSH_PROTOCOL", false],
    ["wrong-rpc", "DSH_PROTOCOL", false],
    ["missing-final", "DSH_PROTOCOL", false],
    ["missing-tool-result", "DSH_PROTOCOL", false],
    ["foreign-prompt", "DSH_PROTOCOL", true],
    ["failed-turn", "DSH_TURN_FAILED", false],
    ["gap", "DSH_PROTOCOL", true],
  ] as const)("rejects %s before emitting successful final evidence", async (mode, code, cancel) => {
    const host = await fixture(mode);
    try {
      const observed: DesktopTurnEvent[] = [];
      await expect(executeDesktopTurn({
        url: host.url, workspace: tmpdir(), prompt: input, onEvent: (event) => { observed.push(event); },
      })).rejects.toMatchObject({ code });
      expect(observed.some(({ type }) => type === "final")).toBe(false);
      expect(host.methods.includes("session/cancel")).toBe(cancel);
    } finally { await host.close(); }
  });

  it("rejects a non-loopback startup address", async () => {
    const host = await fixture("completed");
    try {
      await expect(executeDesktopTurn({ url: host.url.replace("127.0.0.1", "localhost"), workspace: tmpdir(), prompt: input }))
        .rejects.toMatchObject({ code: "DSH_PROTOCOL" });
      expect(host.methods).toEqual([]);
    } finally { await host.close(); }
  });

  it("requests cancellation after an abort that may have passed prompt admission", async () => {
    const host = await fixture("pending");
    try {
      const controller = new AbortController();
      const turn = executeDesktopTurn({ url: host.url, workspace: tmpdir(), prompt: input, signal: controller.signal });
      await host.prompted;
      controller.abort(new Error("fixture stopped"));
      await expect(turn).rejects.toThrow("fixture stopped");
      expect(host.methods).toContain("session/cancel");
    } finally { await host.close(); }
  });
});
