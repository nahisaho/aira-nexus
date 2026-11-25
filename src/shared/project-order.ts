import { z } from 'zod';

/** @id CODE-SID-010 @implements REQ-SID-007 REQ-SID-008 */
export const projectOrderMoveSchema = z
  .strictObject({
    group: z.enum(['pinned', 'recent']),
    projectId: z.uuid().transform((id) => id.toLowerCase()),
    beforeId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .nullable(),
  })
  .refine((move) => move.projectId !== move.beforeId);
export const projectOrderVersionSchema = z.number().int().min(1).max(2147483647);
const ids = z
  .array(z.uuid().transform((id) => id.toLowerCase()))
  .refine((items) => new Set(items).size === items.length);
export const projectOrderSnapshotSchema = z
  .strictObject({
    version: projectOrderVersionSchema,
    pinned: ids,
    recent: ids,
  })
  .refine((snapshot) => !snapshot.recent.some((id) => snapshot.pinned.includes(id)));
export const projectOrderCapabilitySchema = z.strictObject({ enabled: z.boolean() });
export type ProjectOrderMove = z.infer<typeof projectOrderMoveSchema>;
export type ProjectOrderSnapshot = z.infer<typeof projectOrderSnapshotSchema>;
