import { evaluateImplementationPlan } from './implementation-plan-evidence.mjs';

/** @id CODE-NPR-002 @implements REQ-NPR-002 */
function eligiblePendingTask(task, row) {
  const ledgerHashes = Array.isArray(row?.inspection?.ledgerHashes)
    ? new Set(row.inspection.ledgerHashes) : null;
  return ['replan-required', 'revalidation-required'].includes(row?.state)
    && ['not-started', 'in-progress', 'blocked'].includes(task?.status)
    && row.inputsKnown === true && row.bindingsCurrent === true
    && row.historyError === false && Array.isArray(row.history) && row.history.length > 0
    && (task.kind !== 'implementation' || ledgerHashes?.size > 0
      && row.history.every(receipt => receipt.ledgerEvents.every(event =>
        event.hashes.every(hash => ledgerHashes.has(hash)))))
    && task.receipt === row.history.at(-1).path
    && Array.isArray(row.artifacts) && row.artifacts.every(([, hash]) =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    && Array.isArray(row.inspection?.errors)
    && row.inspection.errors.every(error => error.phase === 'verification');
}

/** @id CODE-NPR-004 @implements REQ-NPR-004 */
export function evaluateCurrentPlanReadiness(options) {
  const result = evaluateImplementationPlan(options);
  if (result.stage !== 'consistency' || result.tasks.length === 0) return result;
  const authored = new Map(options.model.tasks.map(task => [task.id, task]));
  const observed = new Map(result.tasks.map(row => [row.id, row]));
  const errors = result.errors.filter(error => !eligiblePendingTask(authored.get(error.id), observed.get(error.id)));
  if (errors.length === result.errors.length) return result;
  const exit = errors.some(error => error.exit === 1) ? 1 : errors.length ? 2 : 0;
  return { ...result, errors, exit, status: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : 'INCOMPLETE' };
}
