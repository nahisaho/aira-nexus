/** @id CODE-NB-004 @implements REQ-NB-004 */
export function notebookEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NOTEBOOK_ENABLED === undefined || env.NOTEBOOK_ENABLED === 'false') return false;
  if (env.NOTEBOOK_ENABLED === 'true') return true;
  throw new Error('Invalid NOTEBOOK_ENABLED configuration.');
}
