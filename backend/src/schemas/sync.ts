import { z } from "zod";

export const zSyncPlan = z.object({
  version: z.string().default("1.0"),
  // length must equal scenes.length; each entry is a list of narration line indices
  pairs: z.array(z.array(z.number().int().nonnegative())),
  // optional small silence between lines when concatenating
  breath_gap_sec: z.number().min(0).max(2).optional().default(0.12),
});

export type SyncPlan = z.infer<typeof zSyncPlan>;
