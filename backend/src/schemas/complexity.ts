import { z } from "zod";

export const zComplexity = z.object({
  time: z.object({
    best: z.string(),
    avg: z.string(),
    worst: z.string(),
  }),
  space: z.object({
    aux: z.string(),
  }),
  explanation: z.string().min(1).max(300),
});

export type Complexity = z.infer<typeof zComplexity>;
