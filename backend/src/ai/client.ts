import { buildDetectPrompt, buildEventsPrompt, buildComplexityPrompt, buildNarrationPrompt, buildSyncPrompt } from "./prompts";
import { zSyncPlan } from "../schemas/sync";
import { validateComplexity } from "../validate";

// at top of ai/client.ts
// Wrap {system,user,json?} into Workers AI chat shape
function toCFChatBody(p: { system?: string; user: string; json?: boolean }) {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (p.system) messages.push({ role: "system", content: p.system });
  messages.push({ role: "user", content: p.user });
  const body: any = { messages };
  if (p.json) body.response_format = { type: "json_object" };
  return body;
}

// Extract parsed JSON from Workers AI result regardless of variant
function getAIJson(raw: any): any {
  if (raw == null) throw new Error("AI returned empty response");

  // If CF already returned a parsed object when we requested json_object
  if (raw && typeof raw.response === "object" && raw.response !== null) {
    return raw.response;
  }

  // Try common text fields
  const candidates = [
    typeof raw === "string" ? raw : undefined,
    typeof raw.response === "string" ? raw.response : undefined,
    typeof raw.output_text === "string" ? raw.output_text : undefined,
    typeof raw.output === "string" ? raw.output : undefined,
  ].filter(Boolean) as string[];

  for (const t of candidates) {
    const s = t.trim();
    if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
  }

  // As a fallback, give validators the object directly
  if (typeof raw === "object") return raw;

  const prev = (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 400);
  throw new Error(`Unable to extract JSON from AI response. Preview: ${prev}`);
}

export async function runDetect(env: any, code: string, language: string) {
  const p = buildDetectPrompt(code, language);         // should set json: true
  const raw = await env.AI.run(env.AI_MODEL_DETECT, toCFChatBody(p));
  const obj = getAIJson(raw);
  return {
    algo_id: typeof obj.algo_id === "string" ? obj.algo_id : "rotated_binary_search",
    confidence: Number.isFinite(obj.confidence) ? obj.confidence : 0.7,
    ds: Array.isArray(obj.ds) && obj.ds.length ? obj.ds : ["array"],
  };
}

export async function runEvents(env: any, algoId: string, code: string, language: string) {
  const p = buildEventsPrompt(algoId, code, language);
  const raw = await env.AI.run(env.AI_MODEL_EVENTS, toCFChatBody(p));
  return getAIJson(raw);
}

export async function runNarration(env: any, algoId: string, events: unknown) {
  const p = buildNarrationPrompt(algoId, events);
  const raw = await env.AI.run(env.AI_MODEL_NARRATION, toCFChatBody(p));
  return getAIJson(raw);
}

export async function runComplexity(env: any, algoId: string) {
  const p = buildComplexityPrompt(algoId);
  const raw = await env.AI.run(env.AI_MODEL_NARRATION, toCFChatBody(p));
  return getAIJson(raw);
}

export async function runSync(env: any, events: unknown, narration: { lines: string[] }) {
  const p = buildSyncPrompt(events, narration);
  const raw = await env.AI.run(env.AI_MODEL_NARRATION, toCFChatBody(p));
  return getAIJson(raw);
}
