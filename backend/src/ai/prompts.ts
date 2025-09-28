import { TEMPLATE_SPEC } from "../spec/templates";

const SPEC_JSON = JSON.stringify(TEMPLATE_SPEC);

// All builders return a plain object you’ll pass to Workers AI later.
// We keep `json: true` to encourage strict JSON outputs.

export function buildDetectPrompt(code: string, language: string) {
  return {
    system:
      "You identify the primary algorithm in short code snippets and return a minimal JSON object.",
    user:
`Language: ${language}
Code:
\`\`\`
${code}
\`\`\`

Return JSON only:
{
  "algo_id": "<one of: two_sum_map | two_sum_two_pointers | three_sum | binary_search | rotated_binary_search | stock_profit | kadane | sliding_window_k | remove_dupes_sorted | reverse_ll | ll_detect_cycle | ll_merge_sorted | ll_middle | valid_parentheses | min_stack | next_greater | queue_with_two_stacks | sliding_window_max>",
  "confidence": 0.0-1.0,
  "ds": ["array"|"arraylist"|"linkedlist"|"stack"|"queue"|"deque"]
}`,
    json: true,
  };
}

export function buildEventsPrompt(algoId: string, code: string, language: string) {
  return {
    system:
`You produce a storyboard for an educational video as a list of SCENES following this SPEC.
STRICTLY obey the SPEC. Output JSON only. Do NOT invent fields.

SPEC:
${SPEC_JSON}

Global rules to respect:
- Total scenes ≤ 150.
- Prefer arrays with ≤ 12 items.
- Indices are integers ≥ 0.
- For ArrayTape frames: ensure 0 ≤ left ≤ mid ≤ right < array.length when present.
- Emit exactly ONE ComplexityCard near the end.
- ResultCard must be the final scene.
- If data is unchanged across frames, you may omit "array" in later ArrayTape scenes.
`,
    user:
`Algorithm: ${algoId}
Language: ${language}
Original code (for context only):
\`\`\`
${code}
\`\`\`

Return JSON only with:
{
  "version": "1.0",
  "input": { ... tiny example inputs you will demonstrate ... },
  "scenes": [ ... list of Scene objects as per SPEC ... ]
}
`,
    json: true,
  };
}

export function buildNarrationPrompt(algoId: string, events: unknown) {
  const eventsPreview = JSON.stringify(events).slice(0, 4000); // cap to keep prompt small
  return {
    system:
`You write very concise narration lines for a code-explanation video. Keep language simple.
Output JSON only as: { "version":"1.0", "lines":[ "...", "...", ... ] }.
3–8 lines total. Each line should map to one or more adjacent scenes.
No line > 180 chars.`,
    user:
`Algorithm: ${algoId}
Storyboard (truncated if long):
${eventsPreview}

Return JSON only with { "version":"1.0", "lines":[ ... ] }`,
    json: true,
  };
}

export function buildComplexityPrompt(algoId: string) {
  return {
    system:
`You explain Big-O time and space for the given algorithm.
Output JSON only as:
{
  "time": {"best":"O(...)", "avg":"O(...)", "worst":"O(...)"},
  "space": {"aux":"O(...)"},
  "explanation": "<<= 200 chars one-liner>"
}`,
    user:
`Algorithm: ${algoId}
Return JSON only.`,
    json: true,
  };
}
