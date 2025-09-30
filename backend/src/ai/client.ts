import { zSyncPlan } from "../schemas/sync";
import { buildSyncPrompt } from "./prompts";

export interface DetectOut {
  algo_id: string;
  confidence: number;
  ds: string[];
}

export async function runDetect(env: any, code: string, language: string): Promise<DetectOut> {
  // Stub for now; proves env vars are wired. Replace with real Workers AI call later.
  return { algo_id: "rotated_binary_search", confidence: 0.92, ds: ["array"] };
}

export async function runEvents(env: any, _algoId: string, _code: string, _language: string) {
  // Minimal valid storyboard stub (ArrayTape + ComplexityCard + ResultCard)
  return {
    version: "1.0",
    input: { nums: [4, 5, 6, 7, 0, 1, 2], target: 0 },
    scenes: [
      { t: "TitleCard", text: "Binary Search (Rotated)" },
      { t: "ArrayTape", left: 0, right: 6, mid: 3 },
      { t: "Callout", text: "Left half is sorted" },
      { t: "MovePointer", which: "left", to: 4 },
      { t: "ArrayTape", left: 4, right: 6, mid: 5 },
      { t: "MovePointer", which: "right", to: 4 },
      { t: "ArrayTape", left: 4, right: 4, mid: 4 },
      { t: "ComplexityCard" },
      { t: "ResultCard", text: "Found at index 4" }
    ]
  };
}

export async function runNarration(_env: any, _algoId: string, _events: unknown) {
  return {
    version: "1.0",
    lines: [
      "We search a rotated sorted array using a binary search idea.",
      "We pick the sorted half and keep only the possible half.",
      "Here the target appears at index four.",
      "Time is O(log n) and space is O(1)."
    ]
  };
}

export async function runComplexity(_env: any, _algoId: string) {
  return {
    time: { best: "O(1)", avg: "O(log n)", worst: "O(log n)" },
    space: { aux: "O(1)" },
    explanation: "Binary-search style halves; only constant extra state."
  };
}

export async function runSync(env: any, events: unknown, narration: { lines: string[] }) {
  const prompt = buildSyncPrompt(events, narration);
  const raw = await env.AI.run(env.AI_MODEL_NARRATION, prompt); 
  const plan = JSON.parse(typeof raw === "string" ? raw : (raw.output_text || raw.output || "{}"));
  return zSyncPlan.parse(plan);
}

