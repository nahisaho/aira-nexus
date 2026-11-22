import type { AppConfig } from '../config.js';
import { ChatError, chatUnavailable } from './errors.js';
import type { ChatRepository } from './repository.js';
import type { ChatConsentService, ChatPreview } from './consent.js';
import type { Principal } from '../../shared/contracts.js';
import type { ChatRun } from '../../shared/chat.js';

export class ChatService {
  constructor(
    public readonly repository: ChatRepository,
    private readonly config: AppConfig,
    private readonly runtimeReady = false,
    private readonly consent?: ChatConsentService,
  ) {}

  async ready(): Promise<void> {
    if (!this.config.jobsEnabled || !this.config.copilot || !this.runtimeReady)
      throw chatUnavailable();
    try {
      await this.repository.ready();
    } catch (error) {
      if (error instanceof ChatError) throw error;
      console.error(JSON.stringify({ event: 'chat_readiness_failed' }));
      throw chatUnavailable();
    }
  }

  async discoverModels(owner: Principal, project: string, confirmed: boolean) {
    if (!this.consent) throw chatUnavailable();
    return this.consent.discoverModels(owner, project, confirmed);
  }

  async createPreview(
    owner: Principal,
    project: string,
    conversation: string,
    value: unknown,
  ): Promise<ChatPreview> {
    if (!this.consent) throw chatUnavailable();
    return this.consent.createPreview(owner, project, conversation, value);
  }

  async confirmPreview(
    owner: Principal,
    project: string,
    conversation: string,
    value: unknown,
    idempotencyKey: string | null,
  ): Promise<ChatRun> {
    if (!this.consent) throw chatUnavailable();
    return this.consent.confirmPreview(
      owner,
      project,
      conversation,
      value,
      idempotencyKey,
      this.repository,
    );
  }
}