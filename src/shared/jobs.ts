import type { Principal } from './contracts.js';

export const jobStates = [
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof jobStates)[number];
export const jobEvents = [
  'claim',
  'cancel',
  'success',
  'error',
  'expiry',
  'heartbeat',
  'stop_ack',
] as const;
export type JobEvent = (typeof jobEvents)[number];
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Job {
  id: string;
  projectId: string;
  type: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  failureCode: string | null;
}
export interface JobPage {
  items: Job[];
  nextCursor: string | null;
}
export interface JobClaim {
  job: Job;
  owner: Principal;
  input: JsonValue;
  fence: string;
}
/** @id CODE-SVC-010 @implements REQ-SVC-003 */
const transitions: Record<JobState, Record<JobEvent, JobState | null>> = {
  queued: {
    claim: 'running',
    cancel: 'cancelled',
    success: null,
    error: null,
    expiry: null,
    heartbeat: null,
    stop_ack: null,
  },
  running: {
    claim: null,
    cancel: 'cancel_requested',
    success: 'succeeded',
    error: 'failed',
    expiry: 'failed',
    heartbeat: 'running',
    stop_ack: null,
  },
  cancel_requested: {
    claim: null,
    cancel: 'cancel_requested',
    success: 'cancelled',
    error: 'cancelled',
    expiry: 'failed',
    heartbeat: 'cancel_requested',
    stop_ack: 'cancelled',
  },
  succeeded: {
    claim: null,
    cancel: 'succeeded',
    success: null,
    error: null,
    expiry: null,
    heartbeat: null,
    stop_ack: null,
  },
  failed: {
    claim: null,
    cancel: 'failed',
    success: null,
    error: null,
    expiry: null,
    heartbeat: null,
    stop_ack: null,
  },
  cancelled: {
    claim: null,
    cancel: 'cancelled',
    success: null,
    error: null,
    expiry: null,
    heartbeat: null,
    stop_ack: null,
  },
};
export function jobTransition(state: JobState, event: JobEvent): JobState | null {
  return transitions[state][event];
}
