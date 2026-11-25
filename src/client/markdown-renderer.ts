import mermaid from 'mermaid';

const protocol = 'aira-markdown-v1';
let accepted = false;

/** @id CODE-MDV-006 @implements REQ-MDV-003 */
window.addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    if (accepted || event.source !== parent || event.ports.length !== 1) return;
    const message = event.data as { protocol?: unknown; source?: unknown };
    if (!message || message.protocol !== protocol || typeof message.source !== 'string') return;
    accepted = true;
    const port = event.ports[0]!;
    const source = message.source;
    const fail = () => {
      port.postMessage({ protocol, error: 'Diagram rendering failed.' });
      port.close();
    };
    if (
      Array.from(source).length > 8192 ||
      /(?:\bclick\b|https?:|javascript:|data:|<\s*[A-Za-z/!]|!\[|@\{|%%\{)/i.test(source) ||
      (source.match(/-->|---|==>|-.->|->>|-->>|<<->>|<-->|<\|--|\*--|o--/g)?.length ?? 0) > 200
    ) {
      fail();
      return;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      maxTextSize: 8192,
      maxEdges: 200,
      suppressErrorRendering: true,
      theme: 'default',
      fontFamily: 'sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      secure: [
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'secure',
      ],
    });
    void (async () => {
      try {
        const { svg } = await mermaid.render('aira-diagram', source);
        if (svg.length > 1000000) throw new Error('Output limit.');
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = parsed.documentElement;
        if (
          parsed.querySelector('parsererror') ||
          root.localName !== 'svg' ||
          parsed.querySelector('a, foreignObject, image, script')
        )
          throw new Error('Unsafe output.');
        const box = root
          .getAttribute('viewBox')
          ?.trim()
          .split(/[\s,]+/)
          .map(Number);
        if (
          !box ||
          box.length !== 4 ||
          !box.every(Number.isFinite) ||
          box[2]! <= 0 ||
          box[3]! <= 0 ||
          box[2]! * box[3]! > 16000000
        )
          throw new Error('Output dimensions.');
        root.setAttribute('width', String(box[2]));
        root.setAttribute('height', String(box[3]));
        for (const style of Array.from(root.querySelectorAll('style'))) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(style.textContent ?? '');
          style.textContent = Array.from(sheet.cssRules)
            .filter((rule) => rule instanceof CSSStyleRule)
            .map((rule) => rule.cssText)
            .join('\n');
        }
        const output = new XMLSerializer().serializeToString(root);
        if (new TextEncoder().encode(output).length > 1000000) throw new Error('Output limit.');
        port.postMessage({ protocol, svg: output });
        port.close();
      } catch {
        fail();
      }
    })();
  },
  { once: false },
);
