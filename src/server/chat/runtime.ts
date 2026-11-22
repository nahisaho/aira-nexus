import { CopilotClient, ToolSet } from '@github/copilot-sdk';
import type { PrivateSdkChild } from './sdk-child.js';
import { createPrivateSdkChild } from './sdk-child.js';

export interface ChatSessionOptions {
  model: string;
  systemMessage: { mode: 'replace'; content: string };
  tools: { availableTools: [] };
  github: { telemetryEnabled: false };
}

export interface ChatSdkSession {
  onMessage(handler: (text: string) => void): () => void;
  onDelta?(handler: (text: string) => void): () => void;
  onIdle(handler: () => void): () => void;
  onError?(handler: () => void): () => void;
  send(input: { prompt: string }): Promise<void>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ChatSdkClient {
  start(): Promise<void>;
  stop(force?: boolean): Promise<void>;
  listModels(): Promise<unknown[]>;
  createSession(options: ChatSessionOptions): Promise<ChatSdkSession>;
}

export type ChatSdkFactory = (token: string, child: PrivateSdkChild) => ChatSdkClient;

/** @id CODE-CHR-003 @implements REQ-CHR-003 */
function defaultClient(token: string, child: PrivateSdkChild): ChatSdkClient {
  const client = new CopilotClient({
    mode: 'empty',
    env: child.env,
    workingDirectory: child.workingDirectory,
    baseDirectory: child.baseDirectory,
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: 'none',
    telemetry: { captureContent: false },
  });
  return {
    start: () => client.start(),
    stop: async (force) => {
      if (force) await client.forceStop();
      else if ((await client.stop()).length > 0) throw new Error('Chat SDK shutdown failed.');
    },
    listModels: async () => client.listModels(),
    createSession: async (options) => {
      const session = await client.createSession({
        model: options.model,
        allowedModels: [options.model],
        systemMessage: options.systemMessage,
        workingDirectory: child.workingDirectory,
        configDirectory: child.env.XDG_CONFIG_HOME,
        availableTools: options.tools.availableTools,
        excludedTools: new ToolSet().addBuiltIn('*').addMcp('*').addCustom('*'),
        tools: [],
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        agentDirectories: [],
        hookDirectories: [],
        instructionDirectories: [],
        pluginDirectories: [],
        enableSkills: false,
        enableConfigDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableOnDemandInstructionDiscovery: false,
        enableSessionStore: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: 'in-memory',
        includeSubAgentStreamingEvents: false,
        infiniteSessions: { enabled: false },
        streaming: true,
        onPermissionRequest: () => ({
          kind: 'denied-no-approval-rule-and-could-not-request-from-user',
        }),
      });
      return {
        onMessage: (handler) =>
          session.on('assistant.message', (event) => {
            if (!event.agentId && !event.checkpoint) handler(event.data.content);
          }),
        onDelta: (handler) =>
          session.on('assistant.message_delta', (event) => {
            if (!event.agentId && !event.checkpoint) handler(event.data.deltaContent);
          }),
        onIdle: (handler) =>
          session.on('session.idle', (event) => {
            if (!event.agentId && !event.checkpoint) handler();
          }),
        onError: (handler) =>
          session.on('session.error', (event) => {
            if (!event.agentId && !event.checkpoint) handler();
          }),
        send: async (input) => {
          await session.send(input);
        },
        abort: () => session.abort(),
        disconnect: () => session.disconnect(),
      };
    },
  };
}

/** @id CODE-CHC-008 @implements REQ-CHC-001 REQ-CHC-004 REQ-CHC-005 */
export class ChatRuntime {
  constructor(private readonly factory: ChatSdkFactory = defaultClient) {}

  private async withClient<T>(
    token: string,
    signal: AbortSignal | undefined,
    action: (
      client: ChatSdkClient,
      prepare: <U>(run: () => Promise<U>) => Promise<U>,
    ) => Promise<T>,
  ) {
    signal?.throwIfAborted();
    const child = await createPrivateSdkChild();
    let client: ChatSdkClient | undefined;
    let force = false;
    const prepare = async <U>(run: () => Promise<U>): Promise<U> => {
      if (!signal) return run();
      signal.throwIfAborted();
      let abort!: () => void;
      const interruption = new Promise<never>((_, reject) => {
        abort = () => {
          force = true;
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return run();
          }),
          interruption,
        ]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    };
    try {
      signal?.throwIfAborted();
      client = this.factory(token, child);
      const sdk = client;
      await prepare(() => sdk.start());
      return await action(sdk, prepare);
    } finally {
      if (client) await client.stop(force);
      await child.dispose();
    }
  }

  async listModels(token: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.withClient(token, signal, async (client, prepare) => {
      const models = await prepare(() => client.listModels());
      return models.map((model) =>
        typeof model === 'object' &&
        model !== null &&
        'id' in model &&
        typeof model.id === 'string' &&
        'name' in model &&
        typeof model.name === 'string'
          ? { id: model.id, name: model.name }
          : model,
      );
    });
  }

  /** @id CODE-CHR-005 @implements REQ-CHR-005 */
  async generate(
    token: string,
    model: string,
    system: string,
    prompt: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onSettled?: () => void,
  ): Promise<string> {
    const result = await this.withClient(token, signal, async (client, prepare) => {
      const session = await prepare(() =>
        client.createSession({
          model,
          systemMessage: { mode: 'replace', content: system },
          tools: { availableTools: [] },
          github: { telemetryEnabled: false },
        }),
      );
      let response: string | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbortDeadline!: (error: Error) => void;
      const abortDeadline = new Promise<never>((_, reject) => {
        rejectAbortDeadline = reject;
      });
      let dispatched = false;
      let terminalSeen = false;
      let resolveTerminal!: (outcome: 'idle' | 'error') => void;
      const terminal = new Promise<'idle' | 'error'>((resolve) => {
        resolveTerminal = resolve;
      });
      const finish = (outcome: 'idle' | 'error') => {
        if (!dispatched || terminalSeen) return;
        terminalSeen = true;
        resolveTerminal(outcome);
      };
      const stopMessage = session.onMessage((text) => {
        if (dispatched && !terminalSeen) response = text;
      });
      const stopDelta =
        onDelta &&
        session.onDelta?.((text) => {
          if (dispatched && !terminalSeen) onDelta(text);
        });
      const stopIdle = session.onIdle(() => finish('idle'));
      const stopError = session.onError?.(() => finish('error'));
      const onAbort = () => {
        abortTimer = setTimeout(
          () => rejectAbortDeadline(new Error('Chat session settlement was not confirmed.')),
          30_000,
        );
        if (!dispatched || terminalSeen) return;
        void session.abort().catch(() => {
          // Neither an abort acknowledgement nor an RPC failure proves local settlement.
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal.aborted) {
          onAbort();
          await Promise.race([session.disconnect(), abortDeadline]);
          return { outcome: 'not-dispatched' } as const;
        }
        dispatched = true;
        await Promise.race([session.send({ prompt }), abortDeadline]);
        const outcome = await Promise.race([terminal, abortDeadline]);
        await Promise.race([session.disconnect(), abortDeadline]);
        return { outcome, response } as const;
      } finally {
        clearTimeout(abortTimer);
        signal.removeEventListener('abort', onAbort);
        stopMessage();
        stopDelta?.();
        stopIdle();
        stopError?.();
      }
    });
    onSettled?.();
    signal.throwIfAborted();
    if (result.outcome !== 'idle' || result.response === undefined)
      throw new Error('Copilot returned no response.');
    return result.response;
  }
}
