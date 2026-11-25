import { z } from 'zod';

/** @id CODE-SID-002 @implements REQ-SID-002 */
export const projectPinInputSchema = z.strictObject({ pinned: z.boolean() });

export const projectPinsSchema = z.strictObject({
  projectIds: z.array(z.uuid()).refine((ids) => new Set(ids).size === ids.length),
});
