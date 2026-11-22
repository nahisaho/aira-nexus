const transitions = {
  starting: {
    device_ready: 'pending',
    provider_error: 'failed',
    deadline: 'failed',
    cancel: 'cancelled',
    supersede: 'cancelled',
    disconnect: 'cancelled',
  },
  pending: {
    authorization_pending: 'pending',
    slow_down: 'pending',
    transport_error: 'pending',
    protocol_error: 'pending',
    access_token: 'approved',
    access_denied: 'denied',
    expired_token: 'expired',
    provider_error: 'failed',
    deadline: 'expired',
    cancel: 'cancelled',
    supersede: 'cancelled',
    disconnect: 'cancelled',
  },
  approved: {},
  denied: {},
  expired: {},
  cancelled: {},
  failed: {},
} as const;
export type CopilotState = keyof typeof transitions;
export type CopilotEvent = keyof typeof transitions.starting | keyof typeof transitions.pending;
export function isCopilotState(value: unknown): value is CopilotState {
  return typeof value === 'string' && Object.hasOwn(transitions, value);
}
export interface CopilotAttempt {
  id: string;
  state: CopilotState;
  expiresAt: string;
  nextPollAt: string;
  userCode?: string;
  verificationUri?: 'https://github.com/login/device';
}
export interface CopilotStatus {
  configured: boolean;
  status: 'disconnected' | 'connected' | 'reconnect_required';
  attempt: CopilotAttempt | null;
}
/** @id CODE-CON-001 @implements REQ-CON-002 */
export function copilotTransition(state: CopilotState, event: CopilotEvent): CopilotState | null {
  const row: Partial<Record<CopilotEvent, CopilotState>> = transitions[state];
  return row[event] ?? null;
}
