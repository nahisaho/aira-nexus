import { z } from 'zod';
export const preferencesSchema = z.strictObject({
  language: z.enum(['ja', 'en']),
  theme: z.enum(['light', 'dark']),
});
export const preferencePatchSchema = preferencesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export type UserPreferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: UserPreferences = Object.freeze({
  language: 'ja',
  theme: 'light',
});

/** @id CODE-FONT-001 @implements REQ-FONT-001 */
export const textSizeSchema = z.strictObject({
  size: z.enum(['large', 'medium', 'small', 'extra-small']),
});
export type TextSizePreference = z.infer<typeof textSizeSchema>;
export const defaultTextSize: TextSizePreference = Object.freeze({ size: 'large' });
