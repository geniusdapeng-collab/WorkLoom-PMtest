/** Run only inside the packaged-runtime verifier's isolated fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { encodeDeepSeekRequest, planDeepSeekWindow } from "./deepseek-window.ts";

globalThis.fetch = () => { throw new Error("Tokenizer must not use the network"); };
const provenance = JSON.parse(await readFile(new URL("./assets/deepseek-v41/provenance.json", import.meta.url), "utf8"));
const checks = [];
assert.ok(provenance.verification.smokeCases.length >= 2);
for (const testCase of provenance.verification.smokeCases) {
  const encoded = await encodeDeepSeekRequest(testCase.body);
  assert.equal(encoded.tokenIds.length, testCase.inputTokens);
  assert.equal(createHash("sha256").update(JSON.stringify(encoded.tokenIds)).digest("hex"), testCase.tokenIdsSha256);
  const plan = await planDeepSeekWindow(testCase.body);
  assert.equal(plan.fullInputTokens, testCase.inputTokens);
  assert.equal(plan.maxOutputTokens, Math.min(393216, 1048576 - testCase.inputTokens));
  checks.push({ id: testCase.id, inputTokens: testCase.inputTokens, maxOutputTokens: plan.maxOutputTokens });
}
console.log(JSON.stringify(checks));
