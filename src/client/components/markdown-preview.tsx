import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import { parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode } from 'domhandler';
import type { FilesApi } from '../files-api';
import type { ProjectFile } from '../../shared/files';
import { ApiError } from '../api';
import { dataImage, pixels, png, svg, utf8Within } from './image-safety';
import 'katex/dist/katex.min.css';
import '../markdown-preview.css';

type Translate = (text: string) => string;
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  depth?: number;
  lang?: string;
  url?: string;
  alt?: string;
  title?: string;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  identifier?: string;
  position?: { start: { offset?: number } };
}
interface Document {
  root: Node;
  references: Map<string, Node>;
  math: Map<Node, ReactNode>;
  images: Set<string>;
  diagrams: Map<Node, number>;
  imageLimit: boolean;
}
const resourceError = 'Markdownの安全なプレビューの上限を超えています。';
const imageError = '画像を表示できません。同じプロジェクト内の一意なPNG/SVG名を指定してください。';
const diagramError = '図を表示できません。構文・上限・描画環境を確認してください。';
const mathError = '数式を表示できません。構文または安全な上限を確認してください。';
const reason = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function Alert({ text, t }: { text: string; t: Translate }) {
  return (
    <span role="alert" className="markdown-error">
      {t(text)}
    </span>
  );
}
function withinPoints(value: string, limit: number) {
  for (let index = 0, count = 0; index < value.length; index++) {
    if (++count > limit) return false;
    if (value.codePointAt(index)! > 0xffff) index++;
  }
  return true;
}
function safeBasename(url: string) {
  const name = url.startsWith('./') ? url.slice(2) : url;
  for (const char of name)
    if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) return undefined;
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/:?#%]/.test(name) ||
    !/\.(png|svg)$/i.test(name)
  )
    return undefined;
  return name;
}

function mathNodes(nodes: ChildNode[], counter: { count: number }): ReactNode[] {
  return nodes.map((node, key) => {
    if (++counter.count > 50000) throw new Error(resourceError);
    if (isText(node)) return node.data;
    if (!isTag(node)) return null;
    const props: Record<string, unknown> = { key };
    for (const [name, value] of Object.entries(node.attribs)) {
      if (name === 'class') props.className = value;
      else if (name === 'style') {
        props.style = Object.fromEntries(
          value.split(';').flatMap((rule) => {
            const colon = rule.indexOf(':');
            return colon < 0
              ? []
              : [
                  [
                    rule
                      .slice(0, colon)
                      .trim()
                      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
                    rule.slice(colon + 1).trim(),
                  ],
                ];
          }),
        );
      } else if (!/^on/i.test(name) && !['href', 'src', 'xlink:href'].includes(name))
        props[name] = value;
    }
    return createElement(node.name, props, ...mathNodes(node.children, counter));
  });
}

/** @id CODE-MDV-001 @implements REQ-MDV-001 REQ-MDV-002 REQ-MDV-005 */
function prepare(text: string): Document {
  const root = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(text) as unknown as Node;
  const references = new Map<string, Node>(),
    math = new Map<Node, ReactNode>(),
    images = new Set<string>(),
    diagrams = new Map<Node, number>();
  const nodes: Node[] = [],
    stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (nodes.length >= 10000 || depth > 128) throw new Error(resourceError);
    nodes.push(node);
    if (node.type === 'definition' && node.identifier) references.set(node.identifier, node);
    for (const child of node.children ?? []) stack.push({ node: child, depth: depth + 1 });
  }
  let expressions = 0;
  const counter = { count: nodes.length * 4 };
  for (const node of nodes.reverse()) {
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.url ?? references.get(node.identifier ?? '')?.url ?? '';
      images.add(url);
    }
    if (node.type === 'code' && node.lang === 'mermaid') diagrams.set(node, diagrams.size);
    if (node.type !== 'math' && node.type !== 'inlineMath') continue;
    if (
      node.type === 'inlineMath' &&
      text.slice(node.position?.start.offset, (node.position?.start.offset ?? 0) + 2) === '$$'
    )
      node.type = 'math';
    const source = node.value ?? '';
    try {
      if (
        ++expressions > 100 ||
        !withinPoints(source, 4096) ||
        /\\(?:href|url|includegraphics|html[A-Za-z]*|class|style|cssId)\b/.test(source)
      )
        throw new Error(mathError);
      const html = katex.renderToString(source, {
        displayMode: node.type === 'math',
        trust: false,
        throwOnError: true,
        strict: 'error',
        maxExpand: 1000,
        maxSize: 10,
        output: 'htmlAndMathml',
        macros: {},
      });
      const next = { count: counter.count };
      const rendered = mathNodes(
        parseDocument(html, { lowerCaseAttributeNames: false }).children,
        next,
      );
      math.set(node, rendered);
      counter.count = next.count;
    } catch {
      math.set(node, null);
    }
  }
  const imageLimit = new Set([...images].map((url) => safeBasename(url)).filter(Boolean)).size > 32;
  return { root, references, math, images, diagrams, imageLimit };
}

interface Budget {
  reserveBytes(count: number): void;
  reservePixels(count: number): void;
}
class ResourceBudget implements Budget {
  #compressed = 0;
  #decoded = 0;
  constructor(readonly content: string) {}
  reserveBytes(count: number) {
    if (this.#compressed + count > 20000000) throw new Error(resourceError);
    this.#compressed += count;
  }
  reservePixels(count: number) {
    if (this.#decoded + count > 32000000) throw new Error(resourceError);
    this.#decoded += count;
  }
}
interface Props {
  text: string;
  api: FilesApi;
  projectId: string;
  t: Translate;
  onAuthenticationError: (cause: unknown) => void;
}
type ImageResult = { src: string } | { error: string };

/** @id CODE-MDV-002 @implements REQ-MDV-004 REQ-MDV-005 */
function useProjectImages(document: Document | undefined, props: Props, budget: Budget) {
  const { api, projectId, onAuthenticationError } = props;
  const [images, setImages] = useState<Map<string, ImageResult>>(new Map());
  const notify = useRef(onAuthenticationError);
  useEffect(() => {
    notify.current = onAuthenticationError;
  }, [onAuthenticationError]);
  useEffect(() => {
    const request = new AbortController();
    const current = () => !request.signal.aborted;
    const update = (urls: string[], result: ImageResult) => {
      if (current())
        setImages((previous) => {
          const next = new Map(previous);
          for (const url of urls) next.set(url, result);
          return next;
        });
    };
    setImages(new Map());
    if (!document?.images.size || document.imageLimit) return () => request.abort();
    const names = new Map<string, string[]>();
    for (const url of document.images) {
      const name = safeBasename(url);
      if (!name) {
        update([url], { error: imageError });
        continue;
      }
      if (!names.has(name) && names.size >= 32) {
        update([url], { error: resourceError });
        continue;
      }
      names.set(name, [...(names.get(name) ?? []), url]);
    }
    if (!names.size) return () => request.abort();
    void (async () => {
      const metadata = new Map<string, ProjectFile[]>(),
        cursors = new Set<string>();
      let cursor: string | undefined,
        pages = 0,
        entries = 0;
      do {
        if (++pages > 1000) throw new Error(resourceError);
        const page = await api.list(projectId, cursor, request.signal);
        if (!current()) return;
        if ((entries += page.items.length) > 100000) throw new Error(resourceError);
        for (const file of page.items)
          if (names.has(file.name))
            metadata.set(file.name, [...(metadata.get(file.name) ?? []), file]);
        if (page.nextCursor && cursors.has(page.nextCursor)) throw new Error(resourceError);
        if (page.nextCursor) cursors.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      // Serial loading enforces aggregate compressed/decode budgets before each allocation.
      for (const [name, urls] of names) {
        if (!current()) return;
        const candidates = metadata.get(name);
        if (candidates?.length !== 1) {
          update(urls, { error: imageError });
          continue;
        }
        const file = candidates[0]!;
        if (
          !['png', 'svg'].includes(file.kind) ||
          file.size < 0 ||
          file.size > (file.kind === 'png' ? 10000000 : 1000000)
        ) {
          update(urls, { error: resourceError });
          continue;
        }
        try {
          budget.reserveBytes(file.size);
          const bytes = await api.content(projectId, file, request.signal);
          if (!current()) return;
          if (bytes.length !== file.size) throw new Error(imageError);
          const kind = file.kind as 'png' | 'svg';
          budget.reservePixels(
            kind === 'png'
              ? png(bytes)
              : svg(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
          update(urls, { src: dataImage(bytes, kind) });
        } catch (error) {
          if (!current()) return;
          if (error instanceof ApiError && error.status === 401) {
            request.abort();
            notify.current(error);
            return;
          }
          update(urls, { error: reason(error, imageError) });
        }
      }
    })().catch((error: unknown) => {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) {
        request.abort();
        notify.current(error);
        return;
      }
      for (const urls of names.values()) update(urls, { error: reason(error, imageError) });
    });
    return () => request.abort();
  }, [api, projectId, document, budget]);
  return images;
}

/** @id CODE-MDV-003 @implements REQ-MDV-003 REQ-MDV-005 */
function Diagram({
  source,
  index,
  budget,
  t,
}: {
  source: string;
  index: number;
  budget: Budget;
  t: Translate;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<ImageResult>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    const invalid =
      index >= 8 ||
      !withinPoints(source, 8192) ||
      (source.match(/-->|---|==>|-.->|->>|-->>|<<->>|<-->|<\|--|\*--|o--/g)?.length ?? 0) > 200 ||
      /(?:\bclick\b|https?:|javascript:|data:|<\s*[A-Za-z/!]|!\[|@\{|%%\{)/im.test(source);
    if (invalid) {
      setResult({ error: diagramError });
      return;
    }
    if (typeof MessageChannel === 'undefined') {
      setResult({ error: diagramError });
      return;
    }
    const frame = window.document.createElement('iframe'),
      channel = new MessageChannel();
    frame.src = '/markdown-renderer.html';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('title', 'Isolated diagram renderer');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('credentialless', '');
    frame.className = 'markdown-render-frame';
    frame.inert = true;
    const dispose = () => {
      active = false;
      clearTimeout(timer);
      frame.onload = null;
      frame.onerror = null;
      channel.port1.removeEventListener('message', receive);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    };
    const fail = (error = diagramError) => {
      if (active) {
        setResult({ error });
        dispose();
      }
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (!active) return;
      try {
        const message = event.data as { protocol?: unknown; svg?: unknown; error?: unknown };
        if (
          !message ||
          message.protocol !== 'aira-markdown-v1' ||
          typeof message.svg !== 'string' ||
          !utf8Within(message.svg, 1000000)
        )
          throw new Error(diagramError);
        budget.reservePixels(svg(message.svg));
        setResult({ src: dataImage(new TextEncoder().encode(message.svg), 'svg') });
        dispose();
      } catch {
        fail();
      }
    };
    channel.port1.addEventListener('message', receive);
    channel.port1.start();
    let transferred = false;
    frame.onload = () => {
      if (active && !transferred) {
        transferred = true;
        try {
          frame.contentWindow?.postMessage({ protocol: 'aira-markdown-v1', source }, '*', [
            channel.port2,
          ]);
        } catch {
          fail();
        }
      }
    };
    frame.onerror = () => fail();
    const timer = setTimeout(() => fail('図の描画が10秒以内に完了しませんでした。'), 10000);
    host.current?.append(frame);
    return dispose;
  }, [source, index, budget]);
  return (
    <span className="markdown-diagram" ref={host}>
      {result && 'error' in result ? (
        <Alert text={result.error} t={t} />
      ) : result && 'src' in result ? (
        <SafeImage src={result.src} alt={t('図')} t={t} />
      ) : (
        <span role="status">{t('読み込み中…')}</span>
      )}
    </span>
  );
}

function SafeImage({ src, alt, t }: { src: string; alt: string; t: Translate }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Alert text={imageError} t={t} />;
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      onLoad={(event) => {
        try {
          pixels(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
        } catch {
          setFailed(true);
        }
      }}
    />
  );
}

/** @id CODE-MDV-005 @implements REQ-MDV-001 REQ-MDV-002 REQ-MDV-003 REQ-MDV-004 REQ-MDV-005 */
export function MarkdownPreview(props: Props) {
  const { text, t } = props;
  const parsed = useMemo(() => {
    try {
      return { document: prepare(text) };
    } catch (error) {
      return { error: reason(error, resourceError) };
    }
  }, [text]);
  const budget = useMemo<Budget>(() => new ResourceBudget(text), [text]);
  const images = useProjectImages(parsed.document, props, budget);
  if (!parsed.document) return <Alert text={parsed.error ?? resourceError} t={t} />;
  const document = parsed.document;
  const render = (node: Node, key: number | string): ReactNode => {
    const children = () => node.children?.map((child, index) => render(child, `${key}-${index}`));
    const value = node.value ?? '';
    switch (node.type) {
      case 'root':
        return <div key={key}>{children()}</div>;
      case 'text':
        return value;
      case 'html':
        return <span key={key}>{value}</span>;
      case 'paragraph':
        return <p key={key}>{children()}</p>;
      case 'heading':
        return createElement(`h${Math.min(6, Math.max(1, node.depth ?? 1))}`, { key }, children());
      case 'emphasis':
        return <em key={key}>{children()}</em>;
      case 'strong':
        return <strong key={key}>{children()}</strong>;
      case 'delete':
        return <del key={key}>{children()}</del>;
      case 'inlineCode':
        return <code key={key}>{value}</code>;
      case 'code':
        return node.lang === 'mermaid' ? (
          <Diagram
            key={key}
            source={value}
            index={document.diagrams.get(node)!}
            budget={budget}
            t={t}
          />
        ) : (
          <pre key={key}>
            <code>{value}</code>
          </pre>
        );
      case 'math':
      case 'inlineMath':
        return <span key={key}>{document.math.get(node) ?? <Alert text={mathError} t={t} />}</span>;
      case 'blockquote':
        return <blockquote key={key}>{children()}</blockquote>;
      case 'list':
        return node.ordered ? (
          <ol key={key} start={node.start}>
            {children()}
          </ol>
        ) : (
          <ul key={key}>{children()}</ul>
        );
      case 'listItem':
        return (
          <li key={key}>
            {typeof node.checked === 'boolean' && (
              <input type="checkbox" checked={node.checked} disabled readOnly />
            )}
            {children()}
          </li>
        );
      case 'table':
        return (
          <table key={key}>
            <thead>
              <tr>
                {node.children?.[0]?.children?.map((cell, index) => (
                  <th key={index}>
                    {cell.children?.map((child, i) => render(child, `${key}-h-${index}-${i}`))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.children?.slice(1).map((row, index) => (
                <tr key={index}>
                  {row.children?.map((cell, i) => (
                    <td key={i}>
                      {cell.children?.map((child, j) => render(child, `${key}-${index}-${i}-${j}`))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'break':
        return <br key={key} />;
      case 'thematicBreak':
        return <hr key={key} />;
      case 'link':
      case 'linkReference':
        // Preview links are intentionally inert: opening any resource requires an explicit app action.
        return (
          <span key={key} className="markdown-link">
            {children()}
          </span>
        );
      case 'image':
      case 'imageReference': {
        if (document.imageLimit) return <span key={key}>{node.alt ?? ''}</span>;
        const url = node.url ?? document.references.get(node.identifier ?? '')?.url ?? '';
        const result = images.get(url);
        if (result && 'src' in result)
          return <SafeImage key={`${key}-${url}`} src={result.src} alt={node.alt ?? ''} t={t} />;
        return result && 'error' in result ? (
          <Alert key={key} text={result.error} t={t} />
        ) : (
          <span key={key} role="status">
            {t('読み込み中…')}
          </span>
        );
      }
      case 'definition':
        return null;
      default:
        return <span key={key}>{value || children()}</span>;
    }
  };
  return (
    <article className="markdown-preview" aria-label="Markdown">
      {document.imageLimit && <Alert text={resourceError} t={t} />}
      {render(document.root, 0)}
    </article>
  );
}
