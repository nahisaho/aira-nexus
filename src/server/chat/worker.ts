import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { JobCompletion, JobHandlers } from '../jobs/service.js';
import type { CopilotService } from '../copilot/service.js';
import type { ChatRuntime } from './runtime.js';
import type { ChatRepository } from './repository.js';
import { parseModelInventory } from './models.js';
import { CHAT_SYSTEM_MESSAGE } from './snapshot.js';
import { ChatEventWriter } from './event-writer.js';

const inputSchema = z.strictObject({ runId: z.uuid() });
const credentialCheckMs = 5000;

/** @id CODE-CHC-010 @implements REQ-CHC-004 */
export function chatHandlers(
  repository: ChatRepository,
  copilot: CopilotService,
  runtime: ChatRuntime,
): JobHandlers {
  return new Map([
    [
      'chat.generate',
      {
        input: inputSchema,
        async run({ claim, input, signal }) {
          let locallySettled = true;
          const execute = async () => {
            const parsed = inputSchema.parse(input);
            const approved = await repository.dispatchInput(claim, parsed.runId);
            const binding = await copilot.chatCredential(claim.owner);
            if (
              binding.connectionId !== approved.connectionId ||
              binding.generation !== approved.connectionGeneration
            )
              throw new Error('Chat credential binding changed.');

            await copilot.currentChatCredential(claim.owner, binding);
            await repository.dispatchInput(claim, parsed.runId);
            signal.throwIfAborted();
            locallySettled = false;
            const inventory = await runtime.listModels(binding.token, signal);
            locallySettled = true;
            const models = parseModelInventory(inventory);
            if (!models.some((model) => model.id === approved.modelId))
              throw new Error('Confirmed model is no longer available.');

            await copilot.currentChatCredential(claim.owner, binding);
            const current = await repository.dispatchInput(claim, parsed.runId);
            if (
              current.modelId !== approved.modelId ||
              current.snapshotHash !== approved.snapshotHash ||
              current.prompt !== approved.prompt ||
              current.connectionId !== binding.connectionId ||
              current.connectionGeneration !== binding.generation
            )
              throw new Error('Confirmed chat input changed.');
            signal.throwIfAborted();
            const invalidated = new AbortController();
            const generationSignal = AbortSignal.any([signal, invalidated.signal]);
            const finished = new AbortController();
            const monitorSignal = AbortSignal.any([generationSignal, finished.signal]);
            const monitor = (async () => {
              try {
                while (!monitorSignal.aborted) {
                  await delay(credentialCheckMs, undefined, { signal: monitorSignal });
                  if (monitorSignal.aborted) break;
                  await copilot.currentChatCredential(claim.owner, binding);
                }
              } catch (error) {
                if (!monitorSignal.aborted) invalidated.abort(error);
              }
            })();
            const writer = new ChatEventWriter(
              async (eventKey, text) => {
                await copilot.currentChatCredential(claim.owner, binding);
                const event = await repository.appendEvent(claim, {
                  eventKey,
                  type: 'delta',
                  text,
                });
                if (!event) throw new Error('Chat response was fenced before persistence.');
              },
              (error) => invalidated.abort(error),
            );
            let answer: string;
            try {
              locallySettled = false;
              answer = await runtime.generate(
                binding.token,
                current.modelId,
                CHAT_SYSTEM_MESSAGE,
                current.prompt,
                generationSignal,
                (text) => writer.push(text),
                () => {
                  locallySettled = true;
                },
              );
            } finally {
              finished.abort();
              try {
                await writer.finish();
              } finally {
                await monitor;
              }
            }
            generationSignal.throwIfAborted();
            await writer.finish(answer);
          };

          let failed = false;
          try {
            await execute();
          } catch (error) {
            if (!locallySettled) throw error;
            failed = true;
            if (!signal.aborted)
              console.error(JSON.stringify({ event: 'job_handler_failed', jobId: claim.job.id }));
          }
          const completion: JobCompletion = {
            settle: ({ event, interrupted }) =>
              repository.settle(claim, failed ? 'error' : event, interrupted),
          };
          return completion;
        },
      },
    ],
  ]);
}
