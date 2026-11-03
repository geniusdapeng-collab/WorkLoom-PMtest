/**
 * DeepSeek V4.1 text prompt accounting, ported from DeepSeek's MIT-licensed
 * deepseek-recipe 0.2.0 (935817c66f5d6e64838f419692545f06787e485f).
 * See assets/deepseek-v41 for source, licenses, asset hash and parity evidence.
 *
 * The input MUST be the final, masked Chat Completions body. HTTP JSON is not
 * the model prompt: roles, tools, response schemas and reasoning are rendered
 * using the official recipe before BPE encoding. Only template-inserted
 * control tokens are special; a user spelling the same text is plain input.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Tokenizer } from "@huggingface/tokenizers";

export const DEEPSEEK_V41_WINDOW = Object.freeze({
  modelId: "deepseek-flash",
  contextTokens: 1_048_576,
  maxOutputTokens: 393_216,
  recipeVersion: "0.2.0",
  recipeCommit: "935817c66f5d6e64838f419692545f06787e485f",
  tokenizerSha256: "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99",
  tokenizerEngine: "@huggingface/tokenizers@0.2.0",
  accounting: "official-v41-text-prompt" as const,
  multimodal: "reject-until-exact-accounting" as const,
});

export class DeepSeekWindowError extends Error {
  readonly code: "DEEPSEEK_WINDOW_UNSUPPORTED" | "DEEPSEEK_WINDOW_PROTOCOL" | "DEEPSEEK_WINDOW_EXHAUSTED" | "DEEPSEEK_TOKENIZER_INTEGRITY";
  constructor(code: DeepSeekWindowError["code"], message: string) {
    super(message); this.name = "DeepSeekWindowError"; this.code = code;
  }
}
function fail(message: string, code: DeepSeekWindowError["code"] = "DEEPSEEK_WINDOW_PROTOCOL"): never {
  throw new DeepSeekWindowError(code, message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): string {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    fail("DeepSeek text accounting requires valid Unicode strings");
  }
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("DeepSeek request contains a protocol field without verified token accounting", "DEEPSEEK_WINDOW_UNSUPPORTED");
  }
}

// A JSON AST preserves number spelling/type and insertion order even for keys
// like "10" and "2" inside a tool's JSON argument string. JSON.parse alone
// loses both, changing the official DSML prompt and its token IDs.
class JsonNumber { readonly source: string; constructor(source: string) { this.source = source; } }
type Json = null | boolean | string | JsonNumber | Json[] | Map<string, Json>;
function parseOrderedJson(source: string): Json {
  try { JSON.parse(source); } catch { fail("Invalid JSON cannot be accounted as a tool/schema payload"); }
  let at = 0;
  const skip = () => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; };
  const parse = (): Json => {
    skip(); const first = source[at];
    if (first === '"') {
      const start = at++;
      while (at < source.length) {
        const char = source[at++];
        if (char === "\\") at++;
        else if (char === '"') return string(JSON.parse(source.slice(start, at)));
      }
      return fail("Invalid JSON string");
    }
    if (first === "{") {
      at++; skip(); const result = new Map<string, Json>();
      if (source[at] === "}") { at++; return result; }
      for (;;) {
        const key = parse(); if (typeof key !== "string") fail("Invalid JSON object key");
        skip(); if (source[at++] !== ":") fail("Invalid JSON object separator");
        result.set(key, parse()); skip(); const end = source[at++];
        if (end === "}") return result;
        if (end !== ",") fail("Invalid JSON object boundary");
      }
    }
    if (first === "[") {
      at++; skip(); const result: Json[] = [];
      if (source[at] === "]") { at++; return result; }
      for (;;) {
        result.push(parse()); skip(); const end = source[at++];
        if (end === "]") return result;
        if (end !== ",") fail("Invalid JSON array boundary");
      }
    }
    for (const [text, value] of [["null", null], ["true", true], ["false", false]] as const) {
      if (source.startsWith(text, at)) { at += text.length; return value; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0];
    if (!number || !Number.isFinite(Number(number))) return fail("Non-finite JSON number cannot be accounted");
    at += number.length; return new JsonNumber(number);
  };
  const value = parse(); skip(); if (at !== source.length) fail("Invalid trailing JSON data"); return value;
}

function pythonNumber(source: string): string {
  if (!/[.eE]/.test(source) && source !== "-0") {
    const integer = BigInt(source);
    if (integer >= -9_223_372_036_854_775_808n && integer <= 18_446_744_073_709_551_615n) return integer.toString();
  }
  const value = Number(source);
  if (Object.is(value, -0)) return "-0.0";
  const absolute = Math.abs(value);
  if (absolute >= 1e16 || (absolute > 0 && absolute < 1e-4)) {
    return value.toExponential().replace(/e-(\d)$/, "e-0$1");
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
function pythonJson(value: Json): string {
  if (value instanceof JsonNumber) return pythonNumber(value.source);
  if (value instanceof Map) return `{${[...value].map(([key, child]) => `${JSON.stringify(key)}: ${pythonJson(child)}`).join(", ")}}`;
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  return JSON.stringify(value);
}
function objectAst(value: Json): Map<string, Json> {
  if (!(value instanceof Map)) fail("A JSON object schema is required");
  return value;
}
function copyOptional(from: Map<string, Json>, to: Map<string, Json>, names: readonly string[]): void {
  for (const key of names) { const value = from.get(key); if (value !== undefined && value !== null) to.set(key, value); }
}

/** The official strict-tool normalizer writes fields in a fixed order. */
function strictSchema(value: Json, allowEmpty: boolean): Map<string, Json> {
  const node = objectAst(value), type = node.get("type");
  if (Array.isArray(type)) {
    if (!type.every((item) => typeof item === "string" && ["string", "number", "integer", "boolean", "null"].includes(item))) fail("Unsupported strict schema type union");
    const result = new Map<string, Json>([["type", type]]); copyOptional(node, result, ["description"]); return result;
  }
  if (typeof type !== "string") {
    const alternatives = node.get("anyOf");
    if (Array.isArray(alternatives)) {
      const result = new Map<string, Json>([["anyOf", alternatives.map((child) => strictSchema(child, allowEmpty))]]);
      copyOptional(node, result, ["description"]); return result;
    }
    if (typeof node.get("$ref") === "string") return new Map([["$ref", node.get("$ref")!]]);
    return fail("Strict schemas require a supported type, anyOf, or reference");
  }
  const result = new Map<string, Json>([["type", type]]);
  if (type === "object") {
    const properties = node.get("properties") == null ? new Map<string, Json>() : objectAst(node.get("properties")!);
    if (!allowEmpty && properties.size === 0) fail("An empty nested strict object is not supported by the official recipe");
    const required = node.get("required");
    if (required != null && (!Array.isArray(required) || required.length !== properties.size
      || new Set(required).size !== properties.size || required.some((key) => typeof key !== "string" || !properties.has(key)))) {
      fail("Strict schema required properties are inconsistent");
    }
    if (node.get("additionalProperties") != null && node.get("additionalProperties") !== false) fail("Strict schema additionalProperties must be false");
    result.set("properties", new Map([...properties].map(([key, child]) => [key, strictSchema(child, false)])));
    result.set("additionalProperties", false); result.set("required", [...properties.keys()]);
    copyOptional(node, result, ["description"]);
    if (node.get("$def") != null) result.set("$def", new Map([...objectAst(node.get("$def")!)].map(([key, child]) => [key, strictSchema(child, false)])));
  } else if (type === "array") {
    if (!node.has("items")) fail("Strict array schema requires items");
    result.set("items", strictSchema(node.get("items")!, false)); copyOptional(node, result, ["description"]);
  } else if (type === "string") copyOptional(node, result, ["description", "pattern", "format", "enum"]);
  else if (type === "integer" || type === "number") copyOptional(node, result, ["description", "const", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
  else if (type === "boolean" || type === "null") copyOptional(node, result, ["description"]);
  else fail("Unsupported strict schema type");
  return result;
}

const S = Object.freeze({ bos: "<｜begin▁of▁sentence｜>", eos: "<｜end▁of▁sentence｜>", system: "<｜System｜>",
  user: "<｜User｜>", assistant: "<｜Assistant｜>", think: "<think>", endThink: "</think>", dsml: "｜DSML｜", reminder: "<｜latest_reminder｜>" });
const GROUNDING = ["<｜ref｜>", "<｜/ref｜>", "<｜box｜>", "<｜/box｜>", "<｜point｜>", "<｜/point｜>", "<｜polygon｜>", "<｜/polygon｜>"];
interface Segment { text: string; special: boolean }
class Prompt {
  readonly segments: Segment[] = [];
  plain(text: string): void {
    if (!text) return;
    const last = this.segments.at(-1);
    if (last && !last.special) last.text += text;
    else this.segments.push({ text, special: false });
  }
  special(text: string): void { this.segments.push({ text, special: true }); }
  assistant(text: string): void {
    const matches = /<｜\/?(?:ref|box|point|polygon)｜>/gu;
    let start = 0;
    for (const match of text.matchAll(matches)) { this.plain(text.slice(start, match.index)); this.special(match[0]); start = match.index + match[0].length; }
    this.plain(text.slice(start));
  }
  template(parts: TemplateStringsArray, ...values: Array<string | { special: string }>): void {
    parts.forEach((part, index) => { this.plain(part); const value = values[index]; if (typeof value === "string") this.plain(value); else if (value) this.special(value.special); });
  }
}
const special = (token: string) => ({ special: token });
interface Call { id: string; name: string; arguments: string }
interface Message { role: "system" | "user" | "assistant" | "tool" | "latest_reminder"; content: string; reasoning?: string; calls?: Call[]; prefix?: boolean; callId?: string }
interface Tool { name: string; description: string; parameters: Json }
function textContent(value: unknown): string {
  if (typeof value === "string") return string(value);
  if (!Array.isArray(value)) return fail("Message content must be text or text parts");
  return value.map((part) => {
    if (!record(part) || part.type !== "text") fail("Multimodal input has no verified V4.1 accounting adapter", "DEEPSEEK_WINDOW_UNSUPPORTED");
    keys(part, ["type", "text"]); return string(part.text);
  }).join("\n\n");
}
function convertMessages(body: Record<string, unknown>): Message[] {
  if (!Array.isArray(body.messages) || !body.messages.length) fail("DeepSeek messages must be a nonempty array");
  const converted: Message[] = [];
  for (let index = 0; index < body.messages.length; index++) {
    const raw: unknown = body.messages[index]; if (!record(raw)) fail("Invalid message");
    if (raw.role === "system" || raw.role === "user") {
      keys(raw, ["role", "content", "name"]); if (raw.name != null) string(raw.name);
      let content = textContent(raw.content);
      if (raw.role === "system" && content.startsWith("x-anthropic-billing-header")) {
        const starts = [content.indexOf("\n"), content.indexOf("You are")].filter((position) => position >= 0);
        content = starts.length ? content.slice(Math.min(...starts)).replace(/^\p{White_Space}+/u, "") : "";
      }
      if (raw.role !== "system" || content.length) converted.push({ role: raw.role, content });
    } else if (raw.role === "latest_reminder") {
      keys(raw, ["role", "content"]); converted.push({ role: raw.role, content: string(raw.content) });
    } else if (raw.role === "assistant") {
      keys(raw, ["role", "content", "name", "reasoning_content", "tool_calls", "prefix"]);
      if (raw.name != null) string(raw.name);
      if (raw.prefix != null && typeof raw.prefix !== "boolean") fail("Invalid prefix setting");
      if (raw.content == null && raw.tool_calls == null) fail("Assistant message needs content or tool calls");
      const message: Message = { role: "assistant", content: raw.content == null ? "" : textContent(raw.content), prefix: raw.prefix === true };
      if (raw.reasoning_content != null) message.reasoning = string(raw.reasoning_content);
      if (raw.tool_calls != null) {
        if (!Array.isArray(raw.tool_calls) || !raw.tool_calls.length) fail("Assistant tool calls cannot be empty");
        message.calls = raw.tool_calls.map((call: unknown) => {
          if (!record(call) || call.type !== "function" || !record(call.function)) fail("Unsupported historical tool call", "DEEPSEEK_WINDOW_UNSUPPORTED");
          keys(call, ["id", "type", "function"]); keys(call.function, ["name", "arguments"]);
          return { id: string(call.id), name: string(call.function.name), arguments: string(call.function.arguments) };
        });
        const ids = new Set(message.calls.map((call) => call.id));
        if (ids.size !== message.calls.length) fail("Duplicate historical tool-call IDs");
        const replies: Message[] = [];
        for (let count = 0; count < message.calls.length; count++) {
          const reply: unknown = body.messages[++index];
          if (!record(reply) || reply.role !== "tool") fail("Every historical tool call needs its immediately following result");
          keys(reply, ["role", "content", "tool_call_id"]);
          const id = string(reply.tool_call_id);
          if (!ids.delete(id)) fail("Unknown or duplicate tool result ID");
          replies.push({ role: "tool", content: textContent(reply.content), callId: id });
        }
        converted.push(message, ...replies.sort((a, b) => message.calls!.findIndex((call) => call.id === a.callId) - message.calls!.findIndex((call) => call.id === b.callId)));
      } else converted.push(message);
    } else if (raw.role === "tool") fail("Orphan tool result cannot be accounted");
    else fail("Unsupported message role", "DEEPSEEK_WINDOW_UNSUPPORTED");
  }
  const normalized: Message[] = [];
  for (const message of converted) {
    const last = normalized.at(-1);
    if (message.role === "user" && last?.role === "user") last.content += `\n\n${message.content}`;
    else if (!(message.role === "latest_reminder" && last?.role === "latest_reminder")) normalized.push(message);
  }
  return normalized;
}

function convertTools(body: Record<string, unknown>, thinking: boolean): { tools: Tool[]; required: boolean } {
  if (body.tools != null && !Array.isArray(body.tools)) fail("Tool definitions must be an array");
  const rawTools: unknown[] = body.tools as unknown[] ?? [];
  const tools = rawTools.map((raw) => {
    if (!record(raw) || raw.type !== "function" || !record(raw.function)) fail("Only function tools have verified accounting", "DEEPSEEK_WINDOW_UNSUPPORTED");
    keys(raw, ["type", "function"]); keys(raw.function, ["name", "description", "parameters", "strict"]);
    const name = string(raw.function.name);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) fail("Invalid function tool name");
    if (raw.function.strict != null && typeof raw.function.strict !== "boolean") fail("Invalid tool strict flag");
    const description = raw.function.description == null ? "" : string(raw.function.description);
    let parameters = raw.function.parameters == null ? new Map<string, Json>() : parseOrderedJson(JSON.stringify(raw.function.parameters));
    if (raw.function.strict === true && body.tool_choice !== "none") {
      if (raw.function.parameters == null) parameters = new Map<string, Json>([["type", "object"]]);
      parameters = strictSchema(parameters, true);
      if (parameters.get("type") !== "object") fail("Strict tool root must be object");
    } else if (raw.function.parameters != null && body.tool_choice !== "none" && objectAst(parameters).get("type") !== "object") {
      fail("Function parameter schema must be object");
    }
    return { name, description, parameters };
  });
  const choice = body.tool_choice;
  if (choice != null && typeof choice !== "string" && !record(choice)) fail("Invalid tool_choice");
  if (typeof choice === "string" && !["auto", "none", "required"].includes(choice)) fail("Unsupported tool_choice", "DEEPSEEK_WINDOW_UNSUPPORTED");
  if (choice === "none") return { tools: [], required: false };
  if (!tools.length) return { tools: [], required: false };
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) fail("Duplicate function tool names");
  if (record(choice)) {
    keys(choice, ["type", "function"]);
    if (choice.type !== "function" || !record(choice.function)) fail("Unsupported named tool choice");
    keys(choice.function, ["name"]); const name = string(choice.function.name);
    const chosen = tools.find((tool) => tool.name === name);
    if (!chosen) fail("Named tool is not declared");
    if (thinking) fail("Thinking mode does not support forced tools");
    return { tools: [chosen], required: true };
  }
  if (choice === "required" && thinking) fail("Thinking mode does not support required tools");
  return { tools, required: choice === "required" };
}

function appendTools(prompt: Prompt, tools: Tool[]): void {
  const dsml = special(S.dsml), start = special(S.think), end = special(S.endThink);
  prompt.template`## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${dsml} calls>" block like the following:

<${dsml} calls>
<${dsml} invoke name="$TOOL_NAME">
<${dsml} parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${dsml} parameter>
...
</${dsml} invoke>
<${dsml} invoke name="$TOOL_NAME2">
...
</${dsml} invoke>
</${dsml} calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${start}), you MUST output your complete reasoning inside ${start}...${end} BEFORE any tool calls or final response.

Otherwise, output directly after ${end} with tool calls or final response.

### Available Tool Schemas

`;
  prompt.plain(tools.map((tool) => pythonJson(new Map<string, Json>([["name", tool.name], ["description", tool.description], ["parameters", tool.parameters]]))).join("\n"));
  prompt.plain("\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n");
}
function appendCalls(prompt: Prompt, calls: Call[]): void {
  const dsml = special(S.dsml);
  prompt.template`\n\n<${dsml} calls>\n`;
  calls.forEach((call, index) => {
    if (index) prompt.plain("\n");
    prompt.template`<${dsml} invoke name="${call.name}">\n`;
    let parsed: Json;
    try { parsed = parseOrderedJson(call.arguments); }
    catch (error) {
      if (!(error instanceof DeepSeekWindowError)) throw error;
      parsed = new Map([["arguments", call.arguments]]);
    }
    const args = parsed instanceof Map ? parsed : new Map([["arguments", call.arguments]]);
    [...args].forEach(([key, value], parameterIndex) => {
      if (parameterIndex) prompt.plain("\n");
      prompt.template`<${dsml} parameter name="${key}" string="${typeof value === "string" ? "true" : "false"}">${typeof value === "string" ? value : pythonJson(value)}</${dsml} parameter>`;
    });
    prompt.template`\n</${dsml} invoke>`;
  });
  prompt.template`\n</${dsml} calls>`;
}

function snapshotBody(body: Record<string, unknown>): { body: Record<string, unknown>; serializedBody: string } {
  if (!record(body)) fail("DeepSeek request body must be an object");
  let serializedBody: string, snapshot: unknown;
  try { serializedBody = JSON.stringify(body); snapshot = JSON.parse(serializedBody); }
  catch { return fail("DeepSeek request body is not serializable JSON"); }
  if (!record(snapshot)) fail("DeepSeek request body must serialize as an object");
  keys(snapshot, ["model", "messages", "tools", "tool_choice", "thinking", "reasoning_effort", "response_format", "max_tokens", "stream",
    "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "n", "seed", "stream_options", "parallel_tool_calls"]);
  if (snapshot.model !== DEEPSEEK_V41_WINDOW.modelId) fail("Model has no registered exact DeepSeek V4.1 window", "DEEPSEEK_WINDOW_UNSUPPORTED");
  return { body: snapshot, serializedBody };
}

function renderBody(body: Record<string, unknown>): Prompt {
  const effort = body.reasoning_effort;
  if (effort != null && !["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"].includes(String(effort))) fail("Unsupported reasoning effort");
  if (body.thinking != null && !record(body.thinking)) fail("Invalid thinking mode");
  const setting = body.thinking as Record<string, unknown> | undefined;
  if (setting) { keys(setting, ["type", "budget_tokens"]); if (!["enabled", "disabled", "adaptive"].includes(String(setting.type))) fail("Unsupported thinking mode"); }
  const thinking = setting ? setting.type !== "disabled" : effort !== "none";
  const effortScore = ["minimal", "low"].includes(String(effort)) ? "50" : ["max", "ultra"].includes(String(effort)) ? "100" : "75";
  const messages = convertMessages(body);
  const { tools, required } = convertTools(body, thinking);
  let schema: Json | undefined;
  if (body.response_format != null) {
    if (!record(body.response_format)) fail("Invalid response format");
    const format = body.response_format;
    if (format.type === "json_object") {
      keys(format, ["type"]);
      if (!messages.some((message) => /json/i.test(message.content))) fail("JSON object mode requires a JSON instruction");
      schema = new Map([["type", "json_object"]]);
    } else if (format.type === "json_schema") {
      keys(format, ["type", "json_schema"]);
      if (!record(format.json_schema) || !Object.hasOwn(format.json_schema, "schema")) fail("Response schema is missing");
      keys(format.json_schema, ["schema", "name", "strict"]);
      schema = parseOrderedJson(JSON.stringify(format.json_schema.schema));
      if (format.json_schema.strict === true) {
        if (strictSchema(schema, false).get("type") !== "object") fail("Strict response schema root must be object");
      }
    } else if (format.type === "text") keys(format, ["type"]);
    else if (format.type === "regex") { keys(format, ["type", "regex"]); string(format.regex); }
    else fail("Unsupported response format", "DEEPSEEK_WINDOW_UNSUPPORTED");
  }
  const prefix = messages.findIndex((message) => message.prefix);
  if (prefix >= 0 && (prefix !== messages.length - 1 || (Array.isArray(body.tools) && body.tools.length > 0) || messages.some((message) => message.calls || message.role === "tool")
    || (record(body.response_format) && body.response_format.type === "json_object"))) fail("Unsupported assistant prefix combination");
  if ((tools.length || schema !== undefined) && messages[0]?.role !== "system") messages.unshift({ role: "system", content: "" });
  const prompt = new Prompt(); prompt.special(S.bos);
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (index === 0 && (thinking || message.role === "system")) prompt.special(S.system);
    if (index === 0 && thinking) prompt.plain(`Reasoning Effort: ${effortScore} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`);
    if (message.role === "system") {
      if (index > 0) prompt.special(S.system);
      prompt.plain(message.content);
      if (index === 0) {
        if (tools.length) { prompt.plain("\n\n"); appendTools(prompt, tools); }
        if (schema !== undefined) prompt.plain(`\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${pythonJson(schema)}`);
      }
    } else if (message.role === "user" || message.role === "tool") {
      if (previous?.role === "user" || previous?.role === "tool") prompt.plain("\n\n"); else prompt.special(S.user);
      prompt.plain(message.role === "tool" ? `<tool_result>${message.content}</tool_result>` : message.content);
    } else if (message.role === "latest_reminder") { prompt.special(S.reminder); prompt.plain(message.content); }
    else {
      const reasoning = thinking && index > 0 && (tools.length > 0 || message.prefix);
      const partial = message.prefix && !message.content && !message.calls?.length;
      prompt.special(S.assistant); prompt.special(reasoning ? S.think : S.endThink);
      if (reasoning) { prompt.assistant(message.reasoning ?? ""); if (!partial) prompt.special(S.endThink); }
      prompt.assistant(message.content);
      if (message.calls?.length) appendCalls(prompt, message.calls);
      if (!message.prefix) prompt.special(S.eos);
    }
  });
  if (!messages.at(-1)?.prefix) { prompt.special(S.assistant); prompt.special(thinking ? S.think : S.endThink); }
  if (required && tools.length) prompt.template`\n\n<${special(S.dsml)} calls>\n`;
  return prompt;
}

interface TokenizerState { plain: Tokenizer; specialIds: Map<string, number> }
let tokenizerState: Promise<TokenizerState> | undefined;
function loadTokenizer(): Promise<TokenizerState> {
  tokenizerState ??= (async () => {
    let bytes: Buffer;
    try { bytes = await readFile(new URL("./assets/deepseek-v41/tokenizer.json", import.meta.url)); }
    catch { return fail("Bundled DeepSeek tokenizer is missing or unreadable", "DEEPSEEK_TOKENIZER_INTEGRITY"); }
    if (createHash("sha256").update(bytes).digest("hex") !== DEEPSEEK_V41_WINDOW.tokenizerSha256) fail("Bundled DeepSeek tokenizer failed its pinned SHA-256", "DEEPSEEK_TOKENIZER_INTEGRITY");
    const asset = JSON.parse(bytes.toString("utf8"));
    const specialIds = new Map<string, number>(asset.added_tokens.map((token: { content: string; id: number }) => [token.content, token.id]));
    if ([...Object.values(S), ...GROUNDING].some((token) => !specialIds.has(token))) fail("Bundled tokenizer lacks required V4.1 control tokens", "DEEPSEEK_TOKENIZER_INTEGRITY");
    return { plain: new Tokenizer({ ...asset, added_tokens: [] }, {}), specialIds };
  })();
  return tokenizerState;
}

/** Raw prompt/IDs are for parity tests and in-memory diagnostics, never receipts. */
export async function encodeDeepSeekRequest(body: Record<string, unknown>): Promise<{ prompt: string; tokenIds: number[] }> {
  const snapshot = snapshotBody(body);
  const rendered = renderBody(snapshot.body), tokenizer = await loadTokenizer();
  const tokenIds: number[] = [];
  for (const segment of rendered.segments) {
    if (segment.special) {
      const id = tokenizer.specialIds.get(segment.text);
      if (id === undefined) fail("Unregistered V4.1 control token", "DEEPSEEK_TOKENIZER_INTEGRITY");
      tokenIds.push(id);
    } else {
      for (const id of tokenizer.plain.encode(segment.text, { add_special_tokens: false }).ids) tokenIds.push(id);
    }
  }
  return { prompt: rendered.segments.map((segment) => segment.text).join(""), tokenIds };
}

export async function countDeepSeekInputTokens(body: Record<string, unknown>): Promise<number> {
  const { body: snapshot } = snapshotBody(body);
  const rendered = renderBody(snapshot), tokenizer = await loadTokenizer();
  let tokens = 0;
  for (const segment of rendered.segments) {
    // Count the same BPE tokens without materializing a second million-entry
    // ID array and an unused attention mask for full-window requests.
    tokens += segment.special ? 1 : tokenizer.plain.tokenize(segment.text, { add_special_tokens: false }).length;
  }
  return tokens;
}

export interface DeepSeekWindowPlan {
  body: Record<string, unknown>;
  serializedBody: string;
  fullInputTokens: number;
  maxOutputTokens: number;
  contextTokens: number;
  requestSha256: string;
  tokenizerSha256: string;
  recipeVersion: string;
  recipeCommit: string;
}

/** Full per-request capability; no task-total budget or arbitrary reserve. */
export async function planDeepSeekWindow(maskedFinalBody: Record<string, unknown>): Promise<DeepSeekWindowPlan> {
  const { body } = snapshotBody(maskedFinalBody);
  const fullInputTokens = await countDeepSeekInputTokens(body);
  const remaining = DEEPSEEK_V41_WINDOW.contextTokens - fullInputTokens;
  if (remaining < 1) fail("Complete input exhausts the registered model context; lossless task partition is required", "DEEPSEEK_WINDOW_EXHAUSTED");
  const maxOutputTokens = Math.min(DEEPSEEK_V41_WINDOW.maxOutputTokens, remaining);
  body.max_tokens = maxOutputTokens;
  const serializedBody = JSON.stringify(body);
  return { body, serializedBody, fullInputTokens, maxOutputTokens, contextTokens: DEEPSEEK_V41_WINDOW.contextTokens,
    requestSha256: createHash("sha256").update(serializedBody).digest("hex"), tokenizerSha256: DEEPSEEK_V41_WINDOW.tokenizerSha256,
    recipeVersion: DEEPSEEK_V41_WINDOW.recipeVersion, recipeCommit: DEEPSEEK_V41_WINDOW.recipeCommit };
}
