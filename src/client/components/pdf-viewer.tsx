import { useEffect, useRef, useState } from 'react';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFWorker,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from './ui/button';
export interface PdfViewerProps {
  bytes: Uint8Array;
  t: (text: string) => string;
}
const invalid = 'PDFを安全に表示できません。元のファイルをダウンロードしてください。';
const timeout = 'PDFの読み込み・描画が30秒を超えました。ダウンロードして確認してください。';
/** @id CODE-SVC-007 @implements REQ-SVC-009 */
export function PdfViewer({ bytes, t }: PdfViewerProps) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState('');
  const [page, setPage] = useState(1),
    [rendering, setRendering] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const resourceCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    let disposed = false,
      cleaned = false;
    let loading: PDFDocumentLoadingTask | undefined,
      worker: PDFWorker | undefined,
      port: Worker | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      if (loading)
        void loading.destroy().catch(() => console.error('PDF loading-task cleanup failed.'));
      worker?.destroy();
      port?.terminate();
    };
    const timer = setTimeout(() => {
      if (!disposed) {
        setError(timeout);
        cleanup();
      }
    }, 30000);
    resourceCleanup.current = cleanup;
    setDocument(null);
    setError('');
    setPage(1);
    void (async () => {
      const pdf = await import('pdfjs-dist');
      if (disposed || cleaned) return;
      port = new Worker(workerUrl, { type: 'module' });
      worker = pdf.PDFWorker.create({ port });
      // Pinned PDF.js 6 removed eval code generation; CSP also forbids unsafe-eval.
      loading = pdf.getDocument({
        data: bytes,
        worker,
        enableXfa: false,
        useWasm: false,
        disableFontFace: true,
        useWorkerFetch: false,
        useSystemFonts: false,
        cMapUrl: '/pdf-assets/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdf-assets/standard_fonts/',
      });
      const doc = await loading.promise;
      if (disposed || cleaned) return;
      if (!Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > 200)
        throw new Error('PDF page limit.');
      clearTimeout(timer);
      setDocument(doc);
    })().catch((cause: unknown) => {
      if (!disposed && !cleaned) {
        setError(
          cause instanceof Error && cause.name === 'PasswordException'
            ? 'パスワード付きPDFはプレビューできません。'
            : invalid,
        );
        cleanup();
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [bytes]);
  useEffect(() => {
    if (!document || error) return;
    let disposed = false,
      proxy: PDFPageProxy | undefined,
      task: RenderTask | undefined;
    const timer = setTimeout(() => {
      if (!disposed) {
        disposed = true;
        setError(timeout);
        task?.cancel();
        resourceCleanup.current?.();
      }
    }, 30000);
    setRendering(true);
    void (async () => {
      proxy = await document.getPage(page);
      if (disposed) {
        proxy.cleanup();
        return;
      }
      const scale = 1.25,
        dpr = window.devicePixelRatio,
        viewport = proxy.getViewport({ scale });
      const width = Math.ceil(viewport.width * dpr),
        height = Math.ceil(viewport.height * dpr);
      if (
        ![scale, dpr, viewport.width, viewport.height, width, height].every(
          (value) => Number.isFinite(value) && value > 0,
        ) ||
        width * height > 16000000
      )
        throw new Error('PDF canvas limit.');
      const element = canvas.current;
      if (!element) throw new Error('PDF canvas unavailable.');
      element.width = width;
      element.height = height;
      task = proxy.render({
        canvas: element,
        viewport,
        ...(dpr === 1 ? {} : { transform: [dpr, 0, 0, dpr, 0, 0] }),
      });
      await task.promise;
    })()
      .catch(() => {
        if (!disposed) {
          setError(invalid);
          resourceCleanup.current?.();
        }
      })
      .finally(() => {
        clearTimeout(timer);
        proxy?.cleanup();
        if (!disposed) setRendering(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      task?.cancel();
      proxy?.cleanup();
    };
  }, [document, page, error]);
  return (
    <div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!document || page <= 1 || rendering}
              onClick={() => setPage((value) => value - 1)}
            >
              {t('前のページ')}
            </Button>
            <span className="text-xs">
              {page} / {document?.numPages ?? '—'}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!document || page >= document.numPages || rendering}
              onClick={() => setPage((value) => value + 1)}
            >
              {t('次のページ')}
            </Button>
          </div>
          {(!document || rendering) && <p role="status">{t('読み込み中…')}</p>}
          <canvas
            ref={canvas}
            width={0}
            height={0}
            className="h-auto max-w-full"
            aria-label={t('PDFプレビュー')}
          />
        </>
      )}
    </div>
  );
}
