import { z } from 'zod';

export type FileKind = 'text' | 'png' | 'svg' | 'pdf' | 'download';
export interface ProjectFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  kind: FileKind;
  createdAt: string;
}
export interface FilePage {
  items: ProjectFile[];
  nextCursor: string | null;
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
}
export interface UploadMetadata {
  name: string;
  size: number;
}

export const MAX_FILE_BYTES = 100000000;
export const PROJECT_FILE_BYTES = 10000000000;
export const fileNameSchema = z
  .string()
  .refine((name) => !/[/\\\p{Cc}]/u.test(name))
  .transform((name) => name.trim())
  .refine((name) => Array.from(name).length >= 1 && Array.from(name).length <= 255);
export const uploadMetadataSchema = z.strictObject({
  name: fileNameSchema,
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
});
export const projectFileSchema = z.strictObject({
  id: z.uuid(),
  name: fileNameSchema,
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['text', 'png', 'svg', 'pdf', 'download']),
  createdAt: z.iso.datetime(),
});
export const filePageSchema = z
  .strictObject({
    items: z.array(projectFileSchema).max(100),
    nextCursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
    usedBytes: z.number().int().min(0).max(PROJECT_FILE_BYTES),
    reservedBytes: z.number().int().min(0).max(PROJECT_FILE_BYTES),
    limitBytes: z.literal(PROJECT_FILE_BYTES),
  })
  .refine((page) => page.usedBytes + page.reservedBytes <= page.limitBytes);
export function fileKind(name: string): FileKind | undefined {
  const kinds: Record<string, FileKind> = {
    txt: 'text',
    csv: 'text',
    json: 'text',
    md: 'text',
    markdown: 'text',
    py: 'text',
    r: 'text',
    png: 'png',
    svg: 'svg',
    pdf: 'pdf',
    docx: 'download',
    pptx: 'download',
    xlsx: 'download',
    jpg: 'download',
    jpeg: 'download',
  };
  return kinds[name.split('.').at(-1)?.toLowerCase() ?? ''];
}
