import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { containedPlanningPath } from './implementation-plan.mjs';

const refuse = message => { throw new Error(`CONTEXT REFUSED: ${message}`); };
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** @id CODE-CTXPLAN-001 @implements REQ-CTXPLAN-001 REQ-CTXPLAN-002 REQ-CTXPLAN-003 REQ-CTXPLAN-005 */
export function plannedContextArtifacts(model, specs, selected) {
  const root = model.root;
  const canonical = file => relative(root, containedPlanningPath(root, file, { allowMissing: true }));
  const required = new Set(specs.flatMap(spec => spec.artifacts.map(canonical)));
  const tasks = new Map(model.tasks.map(task => [task.id, task]));
  const plannedMissing = new Map();
  const features = selected.map(spec => {
    const owned = model.tasks.filter(task => task.feature === spec.feature).flatMap(task => task.artifacts);
    const paths = [...new Set([...spec.artifacts, ...owned].map(canonical))].sort();
    for (const file of paths) {
      try { fs.lstatSync(path.join(root, file)); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (required.has(file)) refuse(`required specification artifact is missing: ${file}`);
      const owners = model.owners[file];
      if (!Array.isArray(owners) || owners.length === 0) refuse(`missing artifact has no known owners: ${file}`);
      for (const id of owners) {
        const task = tasks.get(id);
        if (!task || !['not-started', 'in-progress', 'blocked'].includes(task.status) || task.receipt !== null) {
          refuse(`missing artifact has a completed, invalid or receipt-bearing owner: ${file} (${id})`);
        }
        const history = `.sdd/plan-evidence/${createHash('sha256').update(id).digest('hex')}`;
        const evidence = containedPlanningPath(root, history, { allowMissing: true, regular: false });
        let present = true;
        try { fs.lstatSync(evidence); }
        catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
        if (present) refuse(`missing artifact owner has task evidence: ${file} (${id})`);
      }
      plannedMissing.set(file, { path: file, owners: [...owners].sort() });
    }
    return { feature: spec.feature, paths };
  });
  return {
    features,
    plannedMissing: [...plannedMissing.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
}

/** @id CODE-CTXPLAN-004 @implements REQ-CTXPLAN-004 */
export function plannedMissingText(plannedMissing) {
  return plannedMissing.length ? [
    '\nPLANNED-MISSING (not yet present; not implementation or verification evidence):',
    ...plannedMissing.map(file => `  ${JSON.stringify(file.path)} owners: ${file.owners.map(id => JSON.stringify(id)).join(', ')}`),
  ] : [];
}
