import { z } from 'zod';
import { ChatError } from './errors.js';

export interface ChatModel {
  id: string;
  name: string;
}

const modelSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  name: z
    .string()
    .refine((value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= 200 && !/\p{Cc}/u.test(value);
    }),
});

/** @id CODE-CHC-002 @implements REQ-CHC-001 */
export function parseModelInventory(value: unknown): ChatModel[] {
  const parsed = z.array(modelSchema).max(1000).safeParse(value);
  if (!parsed.success || new Set(parsed.data.map(({ id }) => id)).size !== parsed.data.length)
    throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Model inventory is unavailable.');
  return parsed.data;
}