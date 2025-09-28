import { z } from "zod";

export const zNarration = z.object({
  version: z.string().default("1.0"),
  lines: z.array(z.string().min(1).max(200)).min(1).max(80),
});

export type Narration = z.infer<typeof zNarration>;
