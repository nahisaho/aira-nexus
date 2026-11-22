// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileViewer } from '../src/client/components/project-files';
import type { FilesApi } from '../src/client/files-api';
import type { ProjectFile } from '../src/shared/files';
import { ApiError } from '../src/client/api';
import { createApp } from '../src/server/app';
import { config } from './helpers/identity';
import type { ProjectRepository } from '../src/server/projects';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encode = (text: string) => new TextEncoder().encode(text);
const makeFile = (
  name: string,
  bytes: Uint8Array,
  kind: ProjectFile['kind'] = 'text',
  id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
): ProjectFile => ({
  id,
  name,
  kind,
  size: bytes.length,
  sha256: '0'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
});
function fixture(text: string) {
  const bytes = encode(text),
    file = makeFile('proof.md', bytes);
  const api = {
    setTrashed: vi.fn<FilesApi['setTrashed']>(),
    emptyTrash: vi.fn<FilesApi['emptyTrash']>(),
    content: vi.fn<FilesApi['content']>(async () => bytes),
    list: vi.fn<FilesApi['list']>(async () => ({
      items: [],
      nextCursor: null,
      usedBytes: 0,
      reservedBytes: 0,
      limitBytes: 10000000000,
    })),
    upload: vi.fn<FilesApi['upload']>(),
  };
  const authentication = vi.fn();
  const element = (scopeKey = 'alice', name = file.name, t = (text: string) => text) => (
    <FileViewer
      scopeKey={scopeKey}
      projectId={projectId}
      file={{ ...file, name }}
      api={api}
      t={t}
      onAuthenticationError={authentication}
    />
  );
  return { bytes, file, api, authentication, element };
}

it('keeps valid Markdown and download available around malformed/trusted TeX commands and expression limits', async () => {
  const f = fixture(
    '# Retained\n\n$x^2$ $\\notARealCommand{x}$ $\\htmlClass{attack}{x}$\n\n' +
      Array.from({ length: 100 }, () => '$x$').join(' '),
  );
  const view = render(f.element());
  expect(await screen.findByRole('heading', { name: 'Retained' })).toBeVisible();
  expect(view.container.querySelector('.katex')).not.toBeNull();
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(2);
  expect(view.container.querySelector('.attack')).toBeNull();
  expect(screen.getByRole('button', { name: 'ダウンロード' })).toBeEnabled();
});

it('checks image metadata limits before content and rejects active SVG without erasing surrounding blocks', async () => {
  const f = fixture('# Retained\n\n![large](large.png)\n\n![active](active.svg)');
  const active = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
  );
  const large = {
    ...makeFile('large.png', new Uint8Array(), 'png', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    size: 10000001,
  };
  const malicious = makeFile('active.svg', active, 'svg', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  f.api.list.mockResolvedValue({
    items: [large, malicious],
    nextCursor: null,
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  f.api.content.mockImplementation(async (_project, file) =>
    file.id === f.file.id ? f.bytes : active,
  );
  const view = render(f.element());
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  expect(f.api.content.mock.calls.some(([, file]) => file.id === large.id)).toBe(false);
  expect(view.container.querySelector('img, svg, script')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Retained' })).toBeVisible();
});

it('aborts pending images, suppresses old-epoch content 401 and does not refetch for locale/name changes', async () => {
  const f = fixture('# Stable\n\n![pending](plot.svg)');
  const image = makeFile(
    'plot.svg',
    encode('<svg/>'),
    'svg',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  );
  f.api.list.mockResolvedValue({
    items: [image],
    nextCursor: null,
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  let rejectImage!: (cause: unknown) => void;
  f.api.content.mockImplementation(async (_project, file) =>
    file.id === f.file.id
      ? f.bytes
      : new Promise<Uint8Array>((_resolve, reject) => {
          rejectImage = reject;
        }),
  );
  const view = render(f.element());
  await waitFor(() => expect(f.api.content).toHaveBeenCalledTimes(2));
  view.rerender(f.element('alice', 'renamed.txt', (text) => `locale:${text}`));
  await act(async () => {});
  expect(f.api.content).toHaveBeenCalledTimes(2);
  expect(f.api.list).toHaveBeenCalledOnce();
  expect(screen.getByRole('heading', { name: 'Stable' })).toBeVisible();
  expect(f.api.content.mock.calls[1]![2]?.aborted).toBe(false);
  const signal = f.api.content.mock.calls[1]![2];
  view.rerender(f.element('bob'));
  expect(signal?.aborted).toBe(true);
  await act(async () => rejectImage(new ApiError(401, 'old epoch')));
  expect(f.authentication).not.toHaveBeenCalled();
  view.unmount();
});

function channels() {
  const created: Array<{
    receive?: (event: MessageEvent) => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    'MessageChannel',
    class {
      state = { receive: undefined as ((event: MessageEvent) => void) | undefined, close: vi.fn() };
      constructor() {
        created.push(this.state);
      }

      port1 = {
        close: () => this.state.close(),
        start: vi.fn(),
        postMessage: vi.fn(),
        addEventListener: (_name: string, callback: (event: MessageEvent) => void) => {
          this.state.receive = callback;
        },
        removeEventListener: vi.fn(),
      };
      port2 = { close: () => this.state.close(), start: vi.fn(), postMessage: vi.fn() };
    },
  );
  return created;
}

it('validates local SVG and renders TeX without invoking a parent-DOM parser', async () => {
  vi.stubGlobal(
    'DOMParser',
    class {
      constructor() {
        throw new Error('Parent DOM parsing is forbidden.');
      }
    },
  );
  const f = fixture('# Retained\n\n$x^2$\n\n![safe](plot.svg)');
  const bytes = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><style>.safe{fill:green}</style><rect class="safe" width="1" height="1"/></svg>',
  );
  const image = makeFile('plot.svg', bytes, 'svg', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  f.api.list.mockResolvedValue({
    items: [image],
    nextCursor: null,
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  f.api.content.mockImplementation(async (_project, file) =>
    file.id === f.file.id ? f.bytes : bytes,
  );
  const view = render(f.element());
  await waitFor(() =>
    expect(view.container.querySelector('img')?.src).toMatch(/^data:image\/svg\+xml;base64,/),
  );
  expect(view.container.querySelector('math')).not.toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('accepts only validated bounded inert diagram replies and closes both ports/frame on success', async () => {
  const created = channels(),
    f = fixture('# Surrounding\n\n```mermaid\nflowchart LR\nA --> B\n```');
  const view = render(f.element());
  const frame = await waitFor(() => {
    const element = view.container.querySelector('iframe');
    expect(element).not.toBeNull();
    return element!;
  });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith(
    { protocol: 'aira-markdown-v1', source: 'flowchart LR\nA --> B' },
    '*',
    expect.any(Array),
  );
  const receive = created[0]!.receive!;
  act(() =>
    receive(
      new MessageEvent('message', {
        data: {
          protocol: 'aira-markdown-v1',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0L1 1"/></svg>',
        },
      }),
    ),
  );
  expect(view.container.querySelector('img')?.src).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(view.container.querySelector('svg, iframe')).toBeNull();
  expect(created[0]!.close).toHaveBeenCalledTimes(2);
  act(() =>
    receive(
      new MessageEvent('message', { data: { protocol: 'aira-markdown-v1', svg: '<script/>' } }),
    ),
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

it('isolates malformed/helper-timeout failures and rejects late messages after close', async () => {
  const created = channels(),
    f = fixture('# Surrounding\n\n```mermaid\nflowchart LR\nA --> B\n```');
  const view = render(f.element());
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  act(() =>
    created[0]!.receive!(
      new MessageEvent('message', {
        data: {
          protocol: 'aira-markdown-v1',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="https://outside.invalid/x"/></svg>',
        },
      }),
    ),
  );
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Surrounding' })).toBeVisible();
  expect(view.container.querySelector('img, iframe')).toBeNull();
  view.unmount();
  const pending = render(f.element());
  await waitFor(() => expect(pending.container.querySelector('iframe')).not.toBeNull());
  vi.useFakeTimers();
  // The actual deadline is installed under fake timers in the fresh viewer.
  pending.unmount();
  const timed = render(f.element());
  await act(async () => {});
  expect(timed.container.querySelector('iframe')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(timed.container.querySelector('iframe')).toBeNull();
  const receive = created.at(-1)!.receive!;
  timed.unmount();
  act(() =>
    receive(new MessageEvent('message', { data: { protocol: 'aira-markdown-v1', svg: '<svg/>' } })),
  );
  expect(document.querySelector('img, iframe')).toBeNull();
});

it('shares the decoded-pixel budget across referenced PNGs and generated Mermaid images', async () => {
  const created = channels();
  const f = fixture(
    '# Retained\n\n![a](a.png)\n\n![b](b.png)\n\n```mermaid\nflowchart LR\nA --> B\n```',
  );
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, 4000);
  header.setUint32(20, 4000);
  const a = makeFile('a.png', bytes, 'png', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  const b = makeFile('b.png', bytes, 'png', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  f.api.list.mockResolvedValue({
    items: [a, b],
    nextCursor: null,
    usedBytes: 48,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  f.api.content.mockImplementation(async (_project, file) =>
    file.id === f.file.id ? f.bytes : bytes,
  );
  const view = render(f.element());
  await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(2));
  act(() =>
    created[0]!.receive!(
      new MessageEvent('message', {
        data: {
          protocol: 'aira-markdown-v1',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        },
      }),
    ),
  );
  expect(screen.getByRole('alert')).toBeVisible();
  expect(view.container.querySelectorAll('img')).toHaveLength(2);
  expect(screen.getByRole('heading', { name: 'Retained' })).toBeVisible();
});

it('bounds compressed fetches and refuses repeated metadata cursors before arbitrary image selection', async () => {
  const f = fixture('# Retained\n\n![a](a.png)\n\n![b](b.png)\n\n![c](c.png)');
  const items = ['a', 'b', 'c'].map((name, index) => ({
    ...makeFile(
      `${name}.png`,
      new Uint8Array(),
      'png',
      `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`,
    ),
    size: 10000000,
  }));
  f.api.list.mockResolvedValue({
    items,
    nextCursor: null,
    usedBytes: 30000000,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  f.api.content.mockImplementation(async (_project, file) =>
    file.id === f.file.id ? f.bytes : new Uint8Array(),
  );
  const view = render(f.element());
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
  expect(f.api.content).toHaveBeenCalledTimes(3);
  expect(f.api.content.mock.calls.some(([, file]) => file.id === items[2]!.id)).toBe(false);
  view.unmount();
  const cyclic = fixture('# Retained\n\n![a](a.png)');
  cyclic.api.list.mockResolvedValue({
    items: [items[0]!],
    nextCursor: 'again',
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 10000000000,
  });
  render(cyclic.element());
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(cyclic.api.list).toHaveBeenCalledTimes(2);
  expect(cyclic.api.content).toHaveBeenCalledOnce();
});

it('starts at most eight isolated diagram frames and closes all their channels on deactivation', async () => {
  const created = channels();
  const f = fixture(
    '# Retained\n\n' +
      Array.from({ length: 9 }, () => '```mermaid\nflowchart LR\nA --> B\n```\n\n').join(''),
  );
  const view = render(f.element());
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(view.container.querySelectorAll('iframe')).toHaveLength(8);
  expect(created).toHaveLength(8);
  view.unmount();
  expect(document.querySelector('iframe')).toBeNull();
  for (const channel of created) expect(channel.close).toHaveBeenCalledTimes(2);
});

it('applies the exact helper-only CSP replacement and preserves every other parent directive and Entra frame source', async () => {
  const app = createApp({
    config,
    projects: {} as ProjectRepository,
    verifyToken: async () => ({ ok: false, status: 401, code: 'UNAUTHENTICATED' }),
  });
  app.get('/', (c) => c.text('parent'));
  app.get('/markdown-renderer.html', (c) => c.text('helper'));
  app.get('/markdown-assets/renderer.js', (c) => c.text('bundle'));
  const original =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com; frame-src https://login.microsoftonline.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const parent = await app.request('/');
  expect(parent.headers.get('content-security-policy')).toBe(
    original.replace(
      'frame-src https://login.microsoftonline.com;',
      `frame-src https://login.microsoftonline.com ${config.publicOrigin}/markdown-renderer.html;`,
    ),
  );
  const helper = await app.request('/markdown-renderer.html');
  expect(helper.headers.get('content-security-policy')).toBe(
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  );
  for (const path of [
    '/markdown-renderer.html/',
    '/MARKDOWN-renderer.html',
    '/auth-redirect.html',
  ]) {
    expect((await app.request(path)).headers.get('content-security-policy')).toBe(
      parent.headers.get('content-security-policy'),
    );
  }
  const asset = await app.request('/markdown-assets/renderer.js');
  expect(asset.headers.get('access-control-allow-origin')).toBe('*');
  expect(parent.headers.get('access-control-allow-origin')).toBeNull();
});
