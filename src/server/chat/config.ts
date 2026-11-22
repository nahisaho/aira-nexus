/** @id CODE-CHH-001 @implements REQ-CHH-005 */
export function chatEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CHAT_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('Invalid CHAT_ENABLED configuration.');
}