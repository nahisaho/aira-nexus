import { App as LiveApp } from '../../src/client/App';
import type { BrowserAuth } from '../../src/client/auth';
import type { ProjectsApi } from '../../src/client/api';
import type { PreferencesApi, TextSizeApi } from '../../src/client/preferences-api';
import { defaultPreferences } from '../../src/shared/preferences';
import type { FilesApi } from '../../src/client/files-api';
import type { ProjectPinsApi } from '../../src/client/project-pins-api';
import type { ProjectOrderApi } from '../../src/client/project-order-api';
import type { ProjectManagementApi } from '../../src/client/project-management-api';
import type { ConversionsApi } from '../../src/client/conversions-api';
import type { ChatApi } from '../../src/client/chat-api';
import type { NotebookApi } from '../../src/client/notebook-api';
import { chatFixture } from './chat';
// jsdom has no layout observer; resize tests supply measured geometry explicitly.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const preferences: PreferencesApi = {
  get: async () => ({ ...defaultPreferences }),
  patch: async (changes) => ({ ...defaultPreferences, ...changes }),
};
const textSize: TextSizeApi = {
  get: async () => ({ size: 'large' }),
  patch: async (value) => value,
};
const files: FilesApi = {
  emptyTrash: async () => {
    throw new Error('Test empty trash is not configured.');
  },
  setTrashed: async () => {
    throw new Error('Test file trash mutation is not configured.');
  },
  list: async () => ({
    items: [],
    nextCursor: null,
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 10000000000,
  }),
  upload: async () => {
    throw new Error('Test file upload is not configured.');
  },
  content: async () => {
    throw new Error('Test file content is not configured.');
  },
};
const pins: ProjectPinsApi = {
  list: async () => [],
  set: async () => {
    throw new Error('Test project pin mutation is not configured.');
  },
};
const order: ProjectOrderApi = {
  capabilities: async () => false,
  get: async () => {
    throw new Error('Test project order read is not configured.');
  },
  move: async () => {
    throw new Error('Test project order move is not configured.');
  },
};
const management: ProjectManagementApi = {
  capabilities: async () => false,
  get: async () => {
    throw new Error('Test project management read is not configured.');
  },
  create: async () => {
    throw new Error('Test project management create is not configured.');
  },
  update: async () => {
    throw new Error('Test project management update is not configured.');
  },
  trash: async () => {
    throw new Error('Test project trash list is not configured.');
  },
  transition: async () => {
    throw new Error('Test project management write is not configured.');
  },
};
const conversions: ConversionsApi = {
  capabilities: async () => ({ enabled: false }),
  list: async () => ({ items: [], nextCursor: null }),
  request: async () => {
    throw new Error('Test conversion request is not configured.');
  },
  cancel: async () => {
    throw new Error('Test conversion cancellation is not configured.');
  },
};
const chatApi: ChatApi = chatFixture({ conversations: [] }).api;
export function App(props: {
  auth: BrowserAuth;
  api: ProjectsApi;
  chatApi?: ChatApi;
  notebookApi?: NotebookApi;
  preferencesApi?: PreferencesApi;
  textSizeApi?: TextSizeApi;
  filesApi?: FilesApi;
  pinsApi?: ProjectPinsApi;
  orderApi?: ProjectOrderApi;
  managementApi?: ProjectManagementApi;
  conversionsApi?: ConversionsApi;
}) {
  return (
    <LiveApp
      {...props}
      chatApi={props.chatApi ?? chatApi}
      preferencesApi={props.preferencesApi ?? preferences}
      textSizeApi={props.textSizeApi ?? textSize}
      filesApi={props.filesApi ?? files}
      pinsApi={props.pinsApi ?? pins}
      orderApi={props.orderApi ?? order}
      managementApi={props.managementApi ?? management}
      conversionsApi={props.conversionsApi ?? conversions}
    />
  );
}
