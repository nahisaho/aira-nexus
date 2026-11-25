import { z } from 'zod';

export const conversionBodySchema = z.strictObject({});
export const conversionJobInputSchema = z.strictObject({ conversionId: z.uuid() });
