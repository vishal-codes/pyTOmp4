import { z } from "zod";

// --- Scene variants ---
export const zTitleCard = z.object({
  t: z.literal("TitleCard"),
  text: z.string().min(1).max(80),
});

export const zResultCard = z.object({
  t: z.literal("ResultCard"),
  text: z.string().min(1).max(140),
});

export const zComplexityCard = z.object({
  t: z.literal("ComplexityCard"),
});

export const zCallout = z.object({
  t: z.literal("Callout"),
  text: z.string().min(1).max(160),
});

export const zArrayTape = z.object({
  t: z.literal("ArrayTape"),
  array: z.array(z.number()).optional(), // may omit if unchanged
  left: z.number().int().nonnegative().optional(),
  right: z.number().int().nonnegative().optional(),
  mid: z.number().int().nonnegative().optional(),
});

export const zMovePointer = z.object({
  t: z.literal("MovePointer"),
  which: z.enum(["left", "right"]),
  to: z.number().int().nonnegative(),
});

export const zHashMapPanel = z.object({
  t: z.literal("HashMapPanel"),
  ops: z.array(
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("insert"), key: z.number(), value: z.number() }),
      z.object({ op: z.literal("check"), key: z.number(), found: z.boolean() }),
    ])
  ).min(1),
});

export const zLLNodes = z.object({
  t: z.literal("LLNodes"),
  values: z.array(z.number()).min(1),
  highlight: z.number().int().nonnegative().optional(),
});

export const zRewireEdge = z.object({
  t: z.literal("RewireEdge"),
  src: z.number().int().nonnegative(),
  dst: z.number().int().nonnegative(),
});

export const zStackPanel = z.object({
  t: z.literal("StackPanel"),
  items: z.array(z.union([z.number(), z.string()])),
  op: z.enum(["push", "pop"]).optional(),
  value: z.union([z.number(), z.string()]).optional(),
});

export const zQueuePanel = z.object({
  t: z.literal("QueuePanel"),
  items: z.array(z.union([z.number(), z.string()])),
  op: z.enum(["enqueue", "dequeue"]).optional(),
  value: z.union([z.number(), z.string()]).optional(),
});

export const zCodePanel = z.object({
  t: z.literal("CodePanel"),
  code: z.string(),
  highlight: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(), // [startLine,endLine]
});

// Union of all scenes
export const zScene = z.discriminatedUnion("t", [
  zTitleCard,
  zResultCard,
  zComplexityCard,
  zCallout,
  zArrayTape,
  zMovePointer,
  zHashMapPanel,
  zLLNodes,
  zRewireEdge,
  zStackPanel,
  zQueuePanel,
  zCodePanel,
]);

export const zEventTrace = z.object({
  version: z.string().default("1.0"),
  input: z.record(z.string(), z.any()).default({}),
  scenes: z.array(zScene).min(1).max(150),
});

export type EventTrace = z.infer<typeof zEventTrace>;
export type Scene = z.infer<typeof zScene>;
