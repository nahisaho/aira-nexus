import { z } from 'zod';
import type { ProjectFile } from './files.js';
import { projectFileSchema } from './files.js';
import { jobStates } from './jobs.js';
import type { JobState } from './jobs.js';
import protocol from './conversion-protocol.json' with { type: 'json' };

export type ConversionState = 'waiting' | JobState;
export interface ConversionArtifact {
  id: string;
  availability: 'available' | 'trashed' | 'missing';
  file: ProjectFile | null;
}
export interface ConversionRequest {
  id: string;
  projectId: string;
  sourceId: string;
  sourceName: string;
  jobId: string | null;
  state: ConversionState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  artifacts: { markdown: ConversionArtifact; json: ConversionArtifact } | null;
}
export interface ConversionPage {
  items: ConversionRequest[];
  nextCursor: string | null;
}
/** @id CODE-DCV-001 @implements REQ-DCV-005 */
const artifactSchema = z
  .strictObject({
    id: z.uuid(),
    availability: z.enum(['available', 'trashed', 'missing']),
    file: projectFileSchema.nullable(),
  })
  .refine((value) =>
    value.availability === 'available' ? value.file?.id === value.id : value.file === null,
  );
export const conversionRequestSchema: z.ZodType<ConversionRequest> = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    sourceId: z.uuid(),
    sourceName: z
      .string()
      .min(1)
      .refine((name) => Array.from(name).length <= 255 && !/[/\\\p{Cc}]/u.test(name)),
    jobId: z.uuid().nullable(),
    state: z.enum(['waiting', ...jobStates]),
    reason: z
      .string()
      .refine((code) => protocol.failureCodes.includes(code))
      .nullable(),
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
    artifacts: z.strictObject({ markdown: artifactSchema, json: artifactSchema }).nullable(),
  })
  .refine(
    (value) =>
      (value.state !== 'waiting' || value.jobId === null) &&
      (value.state === 'succeeded' ? value.artifacts !== null : value.artifacts === null),
  );
export const conversionPageSchema: z.ZodType<ConversionPage> = z.strictObject({
  items: z.array(conversionRequestSchema).max(100),
  nextCursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
