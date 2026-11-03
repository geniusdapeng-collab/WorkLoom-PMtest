# DeepSeek V4.1 request accounting assets

`tokenizer.json` is the unmodified official DeepSeek V4.1 tokenizer at
[deepseek-recipe commit 935817c](https://github.com/deepseek-ai/deepseek-recipe/tree/935817c66f5d6e64838f419692545f06787e485f).
Its SHA-256 is recorded in `provenance.json` and checked before runtime use.
The tokenizer and the TypeScript port of the official request renderer retain
their respective MIT notices in `LICENSE-TOKENIZER.txt` and `LICENSE-RECIPE.txt`.
The pure JavaScript BPE engine is the pinned `@huggingface/tokenizers` 0.2.0
package; its Apache-2.0 license ships with that runtime dependency.

The renderer counts the final masked Chat Completions body, including system
instructions, history, assistant reasoning where the protocol retains it,
tool definitions/results and response schemas. Ordinary content that spells a
control token is encoded as ordinary text. Template-inserted tokens and the
official assistant grounding tokens use their special IDs. Unsupported input
modalities and unknown prompt-affecting fields fail before dispatch.

For `deepseek-flash`, the registered context is 1,048,576 tokens and the maximum
output is 393,216 tokens. The request ceiling is exactly
`min(393216, 1048576 - fullInputTokens)`; task quota admission is separate.
There is no extra context reserve and no 4K/8K default output clamp. Exhaustion
fails without shortening the input.

`fixtures/generate-deepseek-window.py` generates the committed oracle using the
official Python package. The 83-case corpus compares rendered text and every
token ID, covering tools, schemas, history, numeric arguments, Unicode and
literal special-token strings. Python is a development-only oracle and is not
needed by the installed desktop product. `deepseek-window.test.ts` additionally
tests real full-window boundaries. `scripts/verify-runtime-deepseek.mjs` verifies
both packaged copies, licenses and hashes, then runs official smoke cases from
an isolated directory against the packaged production dependencies.

This verifies consistency with the pinned official recipe. The remote provider
can change its implementation, and provider-reported usage remains the billing
authority. A measured provider discrepancy must be retained and investigated;
it must not be disguised by adding a guessed constant to the input count.
