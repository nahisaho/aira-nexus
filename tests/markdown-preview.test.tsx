// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { FileViewer } from '../src/client/components/project-files';
import type { FilesApi } from '../src/client/files-api';
import type { ProjectFile, FilePage } from '../src/shared/files';
import { ApiError } from '../src/client/api';
import { translate } from '../src/client/i18n';
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/test-only-pdf-worker.mjs',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encode = (text: string) => new TextEncoder().encode(text);
function metadata(
  name: string,
  bytes: Uint8Array,
  id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
): ProjectFile {
  return {
    id,
    name,
    kind: 'text',
    size: bytes.length,
    sha256: '0'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
const page = (items: ProjectFile[], nextCursor: string | null = null): FilePage => ({
  items,
  nextCursor,
  reservedBytes: 0,
  usedBytes: items.reduce((total, file) => total + file.size, 0),
  limitBytes: 10000000000,
});
function fixture(text: string) {
  const bytes = encode(text);
  const file = metadata('showcase.md', bytes);
  const api = {
    setTrashed: vi.fn<FilesApi['setTrashed']>(),
    emptyTrash: vi.fn<FilesApi['emptyTrash']>(),
    list: vi.fn<FilesApi['list']>(async () => page([])),
    content: vi.fn<FilesApi['content']>(async () => bytes),
    upload: vi.fn<FilesApi['upload']>(),
  };
  const authentication = vi.fn();
  const component = (scopeKey = 'alice:project', selected = file) => (
    <FileViewer
      scopeKey={scopeKey}
      projectId={projectId}
      file={selected}
      api={api}
      t={(text) => translate('ja', text)}
      onAuthenticationError={authentication}
    />
  );
  return { file, api, bytes, authentication, component };
}

/** @id TEST-MDV-001 @verifies REQ-MDV-001 */
it('TEST-MDV-001 renders read-only Markdown/GFM without author HTML or executable URLs', async () => {
  const f = fixture(
    '# Research\n\n**Bold** and `code`\n\n| A | B |\n|---|---|\n|1|2|\n\n<script>window.owned=1</script>\n<img src="https://outside.invalid/pixel">\n\n[unsafe](javascript:alert(1))',
  );
  const view = render(f.component());
  await waitFor(() => expect(f.api.content).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.queryByRole('heading', { name: 'Research', level: 1 })).not.toBeNull();
  expect(view.container.querySelector('strong')).toHaveTextContent('Bold');
  expect(view.container.querySelector('table')).not.toBeNull();
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(view.container.querySelector('[href^="javascript:"]')).toBeNull();
  expect(view.container.querySelector('img[src^="https://outside.invalid"]')).toBeNull();
  expect(f.api.list).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'ダウンロード' })).toBeEnabled();
});

/** @id TEST-MDV-002 @verifies REQ-MDV-002 */
it('TEST-MDV-002 renders bounded inline/display TeX without trusting author commands', async () => {
  const f = fixture(
    'Inline $x^2$.\n\n$$\\frac{a}{b}=\\sqrt{c}$$\n\n$\\href{javascript:alert(1)}{unsafe}$',
  );
  const view = render(f.component());
  await waitFor(() => expect(f.api.content).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(view.container.querySelector('.katex')).not.toBeNull();
  expect(view.container.querySelector('.katex-display')).not.toBeNull();
  expect(view.container.querySelectorAll('math').length).toBeGreaterThanOrEqual(2);
  const radical = view.container.querySelector('.katex-display svg');
  expect(radical).toHaveAttribute('viewBox', expect.stringMatching(/^0 0 [1-9]\d* [1-9]\d*$/));
  expect(radical).toHaveAttribute('preserveAspectRatio', 'xMinYMin slice');
  expect(view.container.querySelector('[href^="javascript:"]')).toBeNull();
  view.unmount();
  const oversized = fixture(`$${'x'.repeat(4097)}$`);
  render(oversized.component());
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
  expect(document.querySelector('.katex')).toBeNull();
  expect(screen.getByRole('button', { name: 'ダウンロード' })).toBeEnabled();
});

/** @id TEST-MDV-003 @verifies REQ-MDV-003 */
it('TEST-MDV-003 creates only the isolated noninteractive helper and disposes its frame on close', async () => {
  const close = vi.fn();
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = {
        close,
        start: vi.fn(),
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      port2 = {
        close,
        start: vi.fn(),
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    },
  );
  const f = fixture('```mermaid\nflowchart LR\n A[開始] --> B[完了]\n```\n');
  const view = render(f.component());
  await waitFor(() => expect(f.api.content).toHaveBeenCalledOnce());
  await act(async () => {});
  const frame = document.querySelector('iframe[src$="/markdown-renderer.html"]');
  expect(frame).not.toBeNull();
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(frame).toHaveAttribute('aria-hidden', 'true');
  expect(frame).toHaveAttribute('tabindex', '-1');
  expect(frame).not.toHaveStyle({ display: 'none' });
  expect(f.api.list).not.toHaveBeenCalled();
  view.unmount();
  expect(document.querySelector('iframe[src$="/markdown-renderer.html"]')).toBeNull();
  expect(close).toHaveBeenCalled();
});

/** @id TEST-MDV-004 @verifies REQ-MDV-004 */
it('TEST-MDV-004 resolves all scoped pages before image fetch and rejects ambiguous or external references', async () => {
  const f = fixture('![first](./plot.png)\n![repeat](plot.png)');
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  );
  const picture: ProjectFile = {
    ...metadata('plot.png', png, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    kind: 'png',
  };
  const unrelated = metadata('other.txt', encode('other'), 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  f.api.list
    .mockResolvedValueOnce(page([unrelated], 'page-two'))
    .mockResolvedValueOnce(page([picture]));
  f.api.content.mockImplementation(async (_project, file) => {
    if (file.id === f.file.id) return f.bytes;
    if (file.id === picture.id) return png;
    throw new Error('Unexpected content read.');
  });
  const view = render(f.component());
  await waitFor(() => expect(f.api.content).toHaveBeenCalled());
  await act(async () => {});
  expect(f.api.list).toHaveBeenCalled();
  await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(2));
  expect(f.api.list).toHaveBeenNthCalledWith(1, projectId, undefined, expect.any(AbortSignal));
  expect(f.api.list).toHaveBeenNthCalledWith(2, projectId, 'page-two', expect.any(AbortSignal));
  expect(f.api.content.mock.calls.filter(([, file]) => file.id === picture.id)).toHaveLength(1);
  for (const image of view.container.querySelectorAll('img'))
    expect(image.src).toMatch(/^data:image\/png;base64,/);
  view.unmount();
  const duplicate = fixture('![ambiguous](plot.png)');
  duplicate.api.list
    .mockResolvedValueOnce(page([picture], 'again'))
    .mockResolvedValueOnce(page([{ ...picture, id: unrelated.id }]));
  render(duplicate.component());
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
  expect(duplicate.api.content).toHaveBeenCalledOnce();
  cleanup();
  for (const reference of [
    'https://outside.invalid/p.png',
    '//outside.invalid/p.png',
    '../plot.png',
    '/plot.png',
    'folder/plot.png',
    'plot.png?key=x',
    'plot.png#x',
    '%2e%2e%2fplot.png',
    'data:image/png;base64,AAAA',
  ]) {
    const invalid = fixture(`![forbidden](${reference})`);
    const rejected = render(invalid.component());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(invalid.api.content).toHaveBeenCalledOnce();
    expect(rejected.container.querySelector('img')).toBeNull();
    rejected.unmount();
  }
});

/** @id TEST-MDV-005 @verifies REQ-MDV-005 */
it('TEST-MDV-005 bounds parsed nodes/resources and rejects stale image-resolution failures', async () => {
  const excessive = fixture(Array.from({ length: 11000 }, () => 'paragraph\n\n').join(''));
  const view = render(excessive.component());
  await waitFor(() => expect(excessive.api.content).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.queryByRole('alert')).not.toBeNull();
  expect(excessive.api.list).not.toHaveBeenCalled();
  view.unmount();
  const many = fixture(
    Array.from({ length: 33 }, (_, index) => `![${index}](p${index}.png)`).join('\n'),
  );
  const limited = render(many.component());
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
  expect(many.api.content).toHaveBeenCalledOnce();
  limited.unmount();
  const f = fixture('![pending](plot.png)');
  let reject: (cause: Error) => void = () => {
    throw new Error('No pending metadata request.');
  };
  f.api.list.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const changing = render(f.component());
  await waitFor(() => expect(f.api.list).toHaveBeenCalledOnce());
  const signal = f.api.list.mock.calls[0]?.[2];
  const nextBytes = encode('# Next owner');
  const next = metadata('next.md', nextBytes, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  f.api.content.mockResolvedValueOnce(nextBytes);
  changing.rerender(f.component('bob:new-epoch', next));
  expect(signal?.aborted).toBe(true);
  await act(async () => reject(new ApiError(401, 'old session')));
  expect(await screen.findByRole('heading', { name: 'Next owner' })).toBeVisible();
  expect(f.authentication).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(changing.container.querySelectorAll('img')).toHaveLength(0);
});
