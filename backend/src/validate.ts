import { zEventTrace, zNarration, zComplexity } from "./schemas";

export function validateEventTrace(obj: unknown) {
  const trace = zEventTrace.parse(obj);

  // Guardrails: basic pointer sanity and bounds against latest array length if provided
  let lastLen: number | undefined;
  let left: number | undefined;
  let right: number | undefined;

  for (const s of trace.scenes) {
    if (s.t === "ArrayTape") {
      if (s.array) lastLen = s.array.length;
      if (s.left != null) left = s.left;
      if (s.right != null) right = s.right;
      if (s.mid != null && left != null && right != null) {
        if (!(left <= s.mid && s.mid <= right)) {
          throw new Error("mid must be between left and right");
        }
      }
      if (lastLen != null) {
        if (left != null && (left < 0 || left >= lastLen)) throw new Error("left out of bounds");
        if (right != null && (right < 0 || right >= lastLen)) throw new Error("right out of bounds");
      }
    }
    if (s.t === "MovePointer") {
      if (s.which === "left" && left != null && s.to < left) throw new Error("left moved backwards");
      if (s.which === "right" && right != null && s.to > right) throw new Error("right moved backwards");
      if (lastLen != null && (s.to < 0 || s.to >= lastLen)) throw new Error("pointer out of bounds");
      if (s.which === "left") left = s.to;
      else right = s.to;
    }
  }

  return trace;
}

export function validateNarration(obj: unknown) {
  return zNarration.parse(obj);
}

export function validateComplexity(obj: unknown) {
  return zComplexity.parse(obj);
}
