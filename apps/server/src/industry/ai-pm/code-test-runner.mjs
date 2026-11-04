// One OS-sandboxed process per test file. Node's process-isolated reporter
// decodes control frames from the test child's stdout, which project code can
// also write. Read real events here and send a one-use receipt to the host.
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { before } from "node:test";

const preload = process.platform === "linux"
  ? "file:///preload"
  : new URL("./code-test-preload.mjs", import.meta.url).href;
const { run } = await import(preload);
const challenge = readFileSync(0, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(challenge)) throw new Error("Missing test receipt challenge");
const file = resolve(process.argv[2]);
const stringify = JSON.stringify.bind(JSON);
const write = writeSync;
const emit = (line) => write(1, line);
let summary;
let completedTests = 0;
const stream = run({ files: [file], isolation: "none", concurrency: 1, setup(events) {
  // The first root hook sees Node's real TestContext before any project hook
  // or callback can swap its assertion getter for the later evaluator.
  before((context) => Object.freeze(Object.getPrototypeOf(context)));
  // Shield the private event stream from mutations of shared stream methods.
  for (let prototype = Object.getPrototypeOf(events); prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (Object.hasOwn(events, key)) continue;
      Object.defineProperty(events, key, Object.getOwnPropertyDescriptor(prototype, key));
    }
  }
} });
for await (const event of stream) {
  if (event.type === "test:fail") emit(`TEST_FAILURE:${stringify({ name: event.data.name,
    message: event.data.details?.error?.message ?? "test failed", code: event.data.details?.error?.code,
    expected: event.data.details?.error?.expected, actual: event.data.details?.error?.actual })}\n`);
  if (event.type === "test:pass" && !event.data.skip && !event.data.todo && event.data.name !== file) completedTests++;
  if (event.type === "test:summary" && event.data.file === undefined) {
    summary = { success: event.data.success, counts: { ...event.data.counts }, completedTests };
  }
}
if (!summary) throw new Error("Missing node:test completion summary");
emit(`\nPM_TEST_RECEIPT:${challenge}:${stringify(summary)}\n`);
if (!summary.success) process.exitCode = 1;
