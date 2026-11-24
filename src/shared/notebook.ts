import { z } from 'zod';

export const notebookLanguage = z.enum(['python', 'r']);
export type NotebookLanguage = z.infer<typeof notebookLanguage>;
export const NOTEBOOK_CODE_BYTES = 262144;
export const NOTEBOOK_OUTPUT_BYTES = 8388608;
export const NOTEBOOK_STAGE_BYTES = 268435456;
const code = z.string().refine((value) => new TextEncoder().encode(value).length <= NOTEBOOK_CODE_BYTES);
export const notebookCreate = z.strictObject({ language: notebookLanguage, code });
export const notebookSave = z.strictObject({ version: z.number().int().positive(), code });
export const notebookExecute = z.strictObject({
  version: z.number().int().positive(),
  files: z.array(z.uuid()).max(256).default([]),
});
export interface NotebookCell {
  id: string;
  language: NotebookLanguage;
  code: string;
  version: number;
  output: string;
  executedBy: string | null;
  stateLost: boolean;
}
export interface NotebookSnapshot { cells: NotebookCell[] }
