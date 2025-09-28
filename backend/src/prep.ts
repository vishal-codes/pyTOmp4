import { runDetect, runEvents, runNarration, runComplexity } from "./ai/client";
import { validateEventTrace, validateNarration, validateComplexity } from "./validate";

export async function runPrep(env: any, code: string, language: string) {
  // 1) detect
  const det = await runDetect(env, code, language); // { algo_id, confidence, ds }

  // 2) ask for events/narration/complexity (stubs for now)
  const events = await runEvents(env, det.algo_id, code, language);
  const narration = await runNarration(env, det.algo_id, events);
  const complexity = await runComplexity(env, det.algo_id);

  // 3) validate
  validateEventTrace(events);
  validateNarration(narration);
  validateComplexity(complexity);

  // return everything for the next step (R2 saving will come in 1.9/1.10)
  return { det, events, narration, complexity };
}
