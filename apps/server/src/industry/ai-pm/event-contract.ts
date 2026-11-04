import { z } from "zod";
import { assertNoSecrets, CreatePmRunSchema } from "./contract.js";
import type { PmCreateInput } from "./types.js";

export const PmEventId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const PM_EVENT_KEY_PREFIX = "pm-event-v1:";
const RequestInput = z.object({
  goal: CreatePmRunSchema.shape.goal,
  employee: CreatePmRunSchema.shape.employee,
  checks: CreatePmRunSchema.shape.checks,
  searchQuery: z.string().trim().min(1)
    .refine((query) => Array.from(query).length <= 128, "公开检索词最多 128 个字符").optional(),
}).strict();

export const PmThreadEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), eventId: PmEventId, threadId: PmEventId, input: RequestInput, start: z.boolean().optional() }).strict(),
  // Older persisted events lack runId. The store allows that shape only for an exact replay.
  z.object({ kind: z.literal("followup"), eventId: PmEventId, threadId: PmEventId, runId: PmEventId.optional(),
    text: z.string().trim().min(1).max(8000) }).strict(),
]).superRefine((value, context) => {
  try { assertNoSecrets(value); }
  catch { context.addIssue({ code: "custom", message: "事件疑似包含秘密，不能保存或发送给模型" }); }
});

export type PmThreadEvent = z.infer<typeof PmThreadEventSchema>;
export type PmRequestEvent = Extract<PmThreadEvent, { kind: "request" }>;
export interface PmEventReceipt {
  eventId: string;
  threadId: string;
  runId: string;
  decision: "admitted" | "attached";
  replayed: boolean;
}
export interface PmEventSummary {
  eventId: string;
  threadId: string;
  runId: string;
  kind: PmThreadEvent["kind"];
  actor: string;
  createdAt: string;
  excerpt: string;
  bodyTruncated: boolean;
}
export type PmEventRecord = PmEventSummary & PmThreadEvent;

export function createInputFromEvent(event: PmRequestEvent, key: string): PmCreateInput {
  return { goal: event.input.goal, employee: event.input.employee, checks: event.input.checks,
    idempotencyKey: `${PM_EVENT_KEY_PREFIX}${key}` };
}

/** UTF-8 byte cap without splitting a Unicode code point. */
export function boundedPmText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
