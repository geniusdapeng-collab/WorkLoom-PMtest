import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { apply } from "../lib/index.js";

const TOKEN = "c".repeat(43);

async function fixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({
      method: request.method,
      url: request.url,
      token: request.headers["x-workloom-pm-bridge"],
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/pm-dsh/runs") {
      response.end(JSON.stringify({
        run: { id: "run-1", goal: body.goal, status: "created", modelId: "deepseek-flash", usage: { promptTokens: 0, completionTokens: 0 } },
        tasks: [],
        artifacts: [],
      }));
      return;
    }
    if (request.url === "/api/pm-dsh/runs/run-1/start") {
      response.end(JSON.stringify({ run: { id: "run-1", status: "planning" }, tasks: [], artifacts: [] }));
      return;
    }
    if (request.url === "/api/pm-dsh/runs/run-1") {
      response.end(JSON.stringify({
        run: {
          id: "run-1",
          goal: "交付可验证的 PM 产物",
          status: "completed",
          modelId: "deepseek-flash",
          usage: { promptTokens: 120, completionTokens: 30 },
        },
        tasks: [{ id: "task-1", presetKey: "doc-writer", status: "completed", outputRefs: ["需求.md"], summary: "已交付" }],
        artifacts: [{
          taskId: "task-1", path: "需求.md", sha256: "d".repeat(64), sizeBytes: 10,
          mediaType: "text/markdown", verifiedAt: "2026-11-19T00:00:00.000Z",
        }],
        resumeBlock: null,
      }));
      return;
    }
    if (request.url?.startsWith("/api/pm-dsh/runs/run-1/artifacts?")) {
      response.end(JSON.stringify({ path: "需求.md", content: "已验收内容", sha256: "d".repeat(64) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    api: process.env.WORKLOOM_PM_API_URL,
    token: process.env.PM_DSH_BRIDGE_TOKEN,
  };
  process.env.WORKLOOM_PM_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.PM_DSH_BRIDGE_TOKEN = TOKEN;

  const tools = new Map();
  const sections = [];
  const ctx = {
    effect(factory) {
      return factory();
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
  };
  apply(ctx);
  return {
    tools,
    sections,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous.api === undefined) delete process.env.WORKLOOM_PM_API_URL;
      else process.env.WORKLOOM_PM_API_URL = previous.api;
      if (previous.token === undefined) delete process.env.PM_DSH_BRIDGE_TOKEN;
      else process.env.PM_DSH_BRIDGE_TOKEN = previous.token;
    },
  };
}

test("registers PM tools and routes substantive work through the bridge", async () => {
  const fx = await fixture();
  try {
    assert.deepEqual([...fx.tools.keys()].sort(), [
      "pm_cancel_mission",
      "pm_create_mission",
      "pm_get_mission",
      "pm_read_artifact",
      "pm_resume_mission",
      "pm_wait_mission",
    ]);
    assert.match(fx.sections[0].text, /pm_create_mission/u);
    assert.match(fx.sections[0].text, /不能.*声称完成|不要在.*声称完成/u);

    const created = JSON.parse(await fx.tools.get("pm_create_mission").execute(
      { goal: "交付可验证的 PM 产物" },
      { callId: "call-123", signal: new AbortController().signal },
    ));
    assert.equal(created.runId, "run-1");
    assert.equal(created.status, "planning");
    assert.equal(fx.requests[0].token, TOKEN);
    assert.equal(fx.requests[0].body.idempotencyKey, "dsh-call-123");
    assert.equal(fx.requests[1].url, "/api/pm-dsh/runs/run-1/start");

    const waited = JSON.parse(await fx.tools.get("pm_wait_mission").execute(
      { runId: "run-1", timeoutMs: 1000 },
      { callId: "call-124", signal: new AbortController().signal },
    ));
    assert.equal(waited.status, "completed");
    assert.equal(waited.artifacts[0].sha256, "d".repeat(64));
    assert.equal(waited.timedOut, false);

    const artifact = JSON.parse(await fx.tools.get("pm_read_artifact").execute(
      { runId: "run-1", path: "需求.md" },
      { callId: "call-125", signal: new AbortController().signal },
    ));
    assert.equal(artifact.content, "已验收内容");
  } finally {
    await fx.close();
  }
});

test("refuses non-loopback bridge URLs before registering capabilities", () => {
  const previous = {
    api: process.env.WORKLOOM_PM_API_URL,
    token: process.env.PM_DSH_BRIDGE_TOKEN,
  };
  process.env.WORKLOOM_PM_API_URL = "https://example.com";
  process.env.PM_DSH_BRIDGE_TOKEN = TOKEN;
  try {
    assert.throws(() => apply({
      effect: (factory) => factory(),
      tools: { register() { return () => {}; } },
      systemPrompt: { section() { return () => {}; } },
    }), /loopback HTTP URL/u);
  } finally {
    if (previous.api === undefined) delete process.env.WORKLOOM_PM_API_URL;
    else process.env.WORKLOOM_PM_API_URL = previous.api;
    if (previous.token === undefined) delete process.env.PM_DSH_BRIDGE_TOKEN;
    else process.env.PM_DSH_BRIDGE_TOKEN = previous.token;
  }
});
