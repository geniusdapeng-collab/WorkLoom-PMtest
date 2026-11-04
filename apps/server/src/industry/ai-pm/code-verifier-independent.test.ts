import { describe, expect, it } from "vitest";
import { createSandboxCodeVerifier, executeSandboxNodeTests } from "./code-verifier.js";

const signal = () => new AbortController().signal;
const unsupportedOsSandbox = !["darwin", "linux"].includes(process.platform)
  || Number(process.versions.node.split(".")[0]) < 24;

// Actual evaluator attacks run only where production has a mandatory OS sandbox.
// The other suite independently exercises real fail-closed admission elsewhere.
describe.skipIf(unsupportedOsSandbox)("OS sandbox Node24 independent code verification adversarial receipts", () => {
  it.each([
    ["ESM assertion exports", "import assert from 'node:assert/strict';", "assert.equal=()=>{}; assert.deepEqual=()=>{};"],
    ["CJS assertion exports", "import {createRequire} from 'node:module';", "const require=createRequire(import.meta.url); const a=require('node:assert'); a.strict.equal=()=>{}; a.strictEqual=()=>{};"],
    ["reflected assertion exports", "import assert from 'node:assert/strict'; import {syncBuiltinESMExports} from 'node:module';", "Object.defineProperty(assert,'equal',{value:()=>{}}); syncBuiltinESMExports();"],
  ])("a generated module cannot disable a trusted evaluator through %s", async (_name, imports, attack) => {
    const receipt = await executeSandboxNodeTests({ signal: signal(),
      files: [{ path: "wrong.mjs", content: `${imports} try { ${attack} } catch {} export const value=0;` }],
      trustedFiles: [{ path: "trusted.test.mjs", content: "import{test}from'node:test';import assert from'node:assert/strict';import{value}from'./wrong.mjs';test('trusted value must be 42',()=>assert.equal(value,42));" }],
      tests: ["trusted.test.mjs"],
    });
    expect(receipt.testOrigin).toBe("trusted-evaluator");
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBeGreaterThan(0);
    expect(receipt.exitCode).not.toBe(0);
  });

  it("a CJS module cannot redirect a later trusted builtin assertion import", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(),
      files: [{ path: "wrong.cjs", content: `const Module=require('node:module');
const original=Module._load;
try { Module._load=function(name,...args){if(name==='node:assert/strict')return{equal(){}};return original.call(this,name,...args)}; } catch {}
module.exports={value:0};` }],
      trustedFiles: [{ path: "trusted.test.cjs", content: "const{test}=require('node:test');const{value}=require('./wrong.cjs');const assert=require('node:assert/strict');test('trusted value must be 42',()=>assert.equal(value,42));" }],
      tests: ["trusted.test.cjs"],
    });
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBeGreaterThan(0);
    expect(receipt.exitCode).not.toBe(0);
  });

  it("a CJS builtin cache entry cannot replace a later trusted assertion import", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(),
      files: [{ path: "wrong.cjs", content: "try{require.cache.assert={exports:{strict:{equal(){}}}}}catch{}module.exports={value:0};" }],
      trustedFiles: [{ path: "trusted.test.cjs", content: "const{test}=require('node:test');const{value}=require('./wrong.cjs');const assert=require('assert').strict;test('trusted value must be 42',()=>assert.equal(value,42));" }],
      tests: ["trusted.test.cjs"],
    });
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBeGreaterThan(0);
    expect(receipt.exitCode).not.toBe(0);
  });

  it("a module loader hook cannot forge a later dynamic trusted assertion import", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(),
      files: [{ path: "wrong.mjs", content: `import{registerHooks}from'node:module';
try{registerHooks({resolve(name,context,next){if(name==='node:assert/strict')return{url:'data:text/javascript,export default {equal(){}}',shortCircuit:true};return next(name,context)}})}catch{}
export const value=0;` }],
      trustedFiles: [{ path: "trusted.test.mjs", content: "import{test}from'node:test';import{value}from'./wrong.mjs';test('trusted value must be 42',async()=>{const assert=(await import('node:assert/strict')).default;assert.equal(value,42)});" }],
      tests: ["trusted.test.mjs"],
    });
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBeGreaterThan(0);
    expect(receipt.exitCode).not.toBe(0);
  });

  it("normal CJS and context assertions work while evaluator globals and registries resist mutation", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [{
      path: "good.cjs", content: `const test=require('node:test');
for(const mutate of [()=>{Array.prototype.every=()=>true},()=>{globalThis.Array=()=>[]},
  ()=>{test.test=()=>{}},()=>{test.assert.register('equal',()=>{})},()=>{Buffer.from=()=>Buffer.alloc(0)}]){try{mutate()}catch{}}
module.exports={value:42};`,
    }], trustedFiles: [{
      path: "trusted.test.cjs", content: `const{test}=require('node:test');const assert=require('node:assert/strict');const{value}=require('./good.cjs');
test('CJS and immutable evaluator',(t)=>{assert.equal(value,42);t.assert.equal(value,42);
assert.equal([0].every(v=>v===42),false);assert.equal(Array.isArray(0),false);
assert.equal(Object.isFrozen(Array.prototype),true);assert.equal(Object.getOwnPropertyDescriptor(globalThis,'Array').writable,false);
assert.deepEqual([...Buffer.from([1,2])],[1,2]);});`,
    }], tests: ["trusted.test.cjs"] });
    expect(receipt.exitCode, receipt.stdout + receipt.stderr).toBe(0);
    expect(receipt.testSummary?.success).toBe(true);
    expect(receipt.testSummary?.completedTests).toBe(1);
  });

  it("printed TAP summaries followed by process.exit(0) cannot substitute for executed tests", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{
      path: "acceptance.test.mjs",
      content: "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 0'); process.exit(0);",
    }] });
    expect(checks[0]?.passed).toBe(false);
  });

  it("does not accept serialized test-runner frames written by the candidate", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{
      path: "acceptance.test.mjs",
      content: `
import { DefaultSerializer, serialize } from "node:v8";
const header = new DefaultSerializer();
header.writeHeader();
const payload = serialize({ type: "test:pass", data: {
  name: "invented result", nesting: 0, testNumber: 1, details: { type: "test", duration_ms: 0 },
} });
const size = Buffer.alloc(4);
size.writeUInt32BE(payload.length);
process.stdout.write(Buffer.concat([header.releaseBuffer(), size, payload]), () => process.exit(0));
`,
    }] });
    expect(checks[0]?.passed).toBe(false);
  });

  it("cannot replace a failing trusted test with a separate runner or forged receipt", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [{
      path: "wrong.mjs",
      content: `import { run } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
try { run({ isolation: 'none', setup(stream) { stream.push({ type: 'test:pass', data: { name: 'fake' } }); } }); } catch {}
const write = fs.writeSync;
fs.writeSync = (fd, line) => write(fd, typeof line === 'string' ? line.replace('"success":false', '"success":true') : line);
syncBuiltinESMExports();
export const answer = 0;`,
    }], trustedFiles: [{
      path: "trusted.test.mjs",
      content: "import{test}from'node:test';import assert from'node:assert/strict';import{answer}from'./wrong.mjs';test('answer',()=>assert.equal(answer,42));",
    }], tests: ["trusted.test.mjs"] });
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBe(1);
  });

  it("locks the shared TestContext before project hooks can replace trusted assertions", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [{
      path: "wrong.mjs",
      content: `import { before, test } from 'node:test';
function attack(context) {
  try { Object.defineProperty(Object.getPrototypeOf(context), 'assert', { get() { return { equal() {} }; } }); } catch {}
}
before(attack);
test('candidate runs before evaluator', attack);
export const answer = 0;`,
    }], trustedFiles: [{
      path: "trusted.test.mjs",
      content: "import{test}from'node:test';import{answer}from'./wrong.mjs';test('answer',t=>t.assert.equal(answer,42));",
    }], tests: ["trusted.test.mjs"] });
    expect(receipt.testSummary?.success, receipt.stdout + receipt.stderr).toBe(false);
    expect(receipt.testSummary?.counts.failed).toBe(1);
  });

  it("keeps test files in independent processes and aggregates their real results", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [
      { path: "first.test.mjs", content: "import{test}from'node:test';process.env.WORKLOOM_TEST_LEAK='first';test('first',()=>{});" },
      { path: "second.test.cjs", content: "const{test}=require('node:test');const assert=require('node:assert/strict');test('second',()=>assert.equal(process.env.WORKLOOM_TEST_LEAK,undefined));" },
    ] });
    expect(receipt.exitCode, receipt.stdout + receipt.stderr).toBe(0);
    expect(receipt.testSummary).toMatchObject({ success: true, completedTests: 2, counts: { tests: 2, passed: 2, failed: 0 } });
  });

  it("an output flood is killed and cannot generate an accepted code receipt", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), timeoutMs: 10_000, files: [{
      path: "acceptance.test.mjs", content: "while(true)console.log('x'.repeat(8192));",
    }] });
    expect(receipt.outputLimited).toBe(true);
    expect(receipt.exitCode).not.toBe(0);
  });

  it("trusted fixture data alone cannot label a generated test as trusted-evaluator", async () => {
    const receipt = await executeSandboxNodeTests({ signal: signal(), files: [{
      path: "acceptance.test.mjs", content: "import{test}from'node:test';test('model-authored',()=>{});",
    }], trustedFiles: [{ path: "fixture.json", content: "{}" }] });
    expect(receipt.testOrigin).toBe("generated");
  });

  it("test code cannot rewrite a trusted receipt through mutable stdout internals", async () => {
    const checks = await createSandboxCodeVerifier()({ signal: signal(), files: [{
      path: "acceptance.test.mjs",
      content: `import { test } from 'node:test';
const write = process.stdout._write.bind(process.stdout);
process.stdout._write = (chunk, encoding, callback) => {
  let text = chunk.toString();
  const match = /PM_TEST_RECEIPT:([a-f0-9]{64}):/.exec(text);
  if (match) text = '\\nPM_TEST_RECEIPT:' + match[1] + ':' + JSON.stringify({ success: true, counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } }) + '\\n';
  write(Buffer.from(text), encoding, callback);
};
process.on('beforeExit', () => { process.exitCode = 0; });
test('this assertion really fails', () => { throw new Error('must fail'); });`,
    }] });
    expect(checks[0]?.passed).toBe(false);
  });
});
