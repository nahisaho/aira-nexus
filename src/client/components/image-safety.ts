export class PreviewError extends Error {}
const invalidImage = '画像の形式・寸法が不正か、安全なプレビューの上限を超えています。';

export function pixels(width: number, height: number) {
  const count = width * height;
  if (!Number.isFinite(count) || width <= 0 || height <= 0 || count > 16000000)
    throw new PreviewError(invalidImage);
  return count;
}

export function png(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  )
    throw new PreviewError(invalidImage);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) throw new PreviewError(invalidImage);
  return pixels(view.getUint32(16), view.getUint32(20));
}

/** @id CODE-MDV-004 @implements REQ-MDV-003 REQ-MDV-004 */
export function svg(text: string) {
  const unsafe = () =>
    new PreviewError('SVGに安全でない内容・外部参照・不正な寸法が含まれています。');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) throw unsafe();
  const root = new Map<string, string>();
  const allowed = new Set([
    'svg',
    'g',
    'defs',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
    'symbol',
    'use',
    'text',
    'tspan',
    'title',
    'desc',
    'style',
    'marker',
  ]);
  function css(value: string) {
    if (/[@\\]|\/\*/.test(value)) throw unsafe();
    for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
      if (!/^\s*(['"]?)#[\w:.-]+\1\s*$/.test(match[1] ?? '')) throw unsafe();
    }
    if (/url\s*\(/i.test(value.replace(/url\s*\([^)]*\)/gi, ''))) throw unsafe();
  }
  let nodes = 0,
    depth = 0,
    style: string | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw unsafe();
  });
  parser.on('processinginstruction', () => {
    throw unsafe();
  });
  parser.on('error', () => {
    throw unsafe();
  });
  parser.on('opentag', (element) => {
    if (
      ++nodes > 50000 ||
      element.uri !== 'http://www.w3.org/2000/svg' ||
      !allowed.has(element.local) ||
      (depth === 0 && element.local !== 'svg') ||
      style !== undefined
    )
      throw unsafe();
    for (const attribute of Object.values(element.attributes)) {
      const name = attribute.local.toLowerCase(),
        value = attribute.value;
      if (depth === 0) root.set(attribute.name, value);
      if (/^on/.test(name) || name === 'base' || (name === 'href' && !/^#[^\s"'<>]+$/.test(value)))
        throw unsafe();
      if (name === 'style' || /url\s*\(|[@\\]/i.test(value)) css(value);
    }
    if (element.local === 'style') style = '';
    depth++;
  });
  parser.on('text', (value) => {
    if (style !== undefined) style += value;
  });
  parser.on('cdata', (value) => {
    if (style !== undefined) style += value;
  });
  parser.on('closetag', (element) => {
    if (element.local === 'style') {
      css(style ?? '');
      style = undefined;
    }
    depth--;
  });
  try {
    parser.write(text).close();
  } catch (error) {
    throw error instanceof PreviewError ? error : unsafe();
  }
  const dimension = (value: string | null) => {
    if (value === null) return undefined;
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value))
      throw new PreviewError(
        'SVGの寸法指定に対応していません。数値またはpxで保存するか、元のファイルをダウンロードしてください。',
      );
    const number = Number(value.replace(/px$/, ''));
    if (!Number.isFinite(number) || number <= 0) throw unsafe();
    return number;
  };
  let width = dimension(root.get('width') ?? null),
    height = dimension(root.get('height') ?? null);
  const box = root.get('viewBox') ?? null;
  if (box !== null) {
    if (/(?:^|,)\s*(?:,|$)/.test(box)) throw unsafe();
    const tokens = box.trim().split(/[\s,]+/);
    if (tokens.some((token) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)))
      throw unsafe();
    const values = tokens.map(Number);
    if (values.length !== 4 || !values.every(Number.isFinite) || values[2]! <= 0 || values[3]! <= 0)
      throw unsafe();
    const ratio = values[2]! / values[3]!;
    if (width === undefined && height === undefined) {
      width = values[2];
      height = values[3];
    } else if (width === undefined) width = height! * ratio;
    else if (height === undefined) height = width / ratio;
  }
  if (width === undefined || height === undefined) throw unsafe();
  return pixels(width, height);
}

export function dataImage(bytes: Uint8Array, kind: 'png' | 'svg') {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:image/${kind === 'svg' ? 'svg+xml' : 'png'};base64,${btoa(binary)}`;
}

export function utf8Within(text: string, limit: number) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) return false;
  }
  return true;
}
import { SaxesParser } from 'saxes';
