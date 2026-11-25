import { setTimeout as delay } from 'node:timers/promises';
import type { ChatRunEventPage } from '../../shared/chat.js';

/** @id CODE-CHR-006 @implements REQ-CHR-006 */
export async function chatEventStream(
  initialAfter: number,
  signal: AbortSignal,
  readPage: (after: number) => Promise<ChatRunEventPage>,
): Promise<Response> {
  let after = initialAfter;
  let page = await readPage(after);
  let position = 0;
  let keepalive = performance.now() + 15_000;
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const cleanup = () => {
    signal.removeEventListener('abort', abort);
    stop.abort();
  };
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!stop.signal.aborted) {
            const event = page.items[position++];
            if (event) {
              if (event.sequence !== after + 1)
                throw new Error('Noncontiguous chat event sequence.');
              after = event.sequence;
              const data = JSON.stringify({
                id: `${page.run.id}:${after}`,
                runId: page.run.id,
                sequence: after,
                type: event.type,
                ...(event.type === 'delta' ? { text: event.text } : { state: event.state }),
                ...(event.reason ? { failureCode: event.reason } : {}),
              });
              controller.enqueue(encoder.encode(`id: ${after}\ndata: ${data}\n\n`));
              return;
            }
            if (!page.nextCursor) {
              if (
                ['succeeded', 'failed', 'cancelled'].includes(page.run.state) &&
                after >= page.lastSequence
              )
                break;
              if (performance.now() >= keepalive) {
                keepalive = performance.now() + 15_000;
                controller.enqueue(encoder.encode(': keepalive\n\n'));
                return;
              }
              await delay(1000, undefined, { signal: stop.signal });
            }
            page = await readPage(after);
            position = 0;
          }
        } catch {
          if (!stop.signal.aborted)
            console.error(JSON.stringify({ event: 'chat_event_stream_interrupted' }));
        }
        cleanup();
        if (!cancelled) controller.close();
      },
      cancel() {
        cancelled = true;
        cleanup();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
