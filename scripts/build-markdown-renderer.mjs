import { build } from 'vite';

// A classic single-file bundle runs in an opaque sandbox without module-import CORS or credentials.
await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: 'dist/client/markdown-assets',
    emptyOutDir: true,
    lib: {
      entry: 'src/client/markdown-renderer.ts',
      name: 'AiraMarkdownRenderer',
      formats: ['iife'],
      fileName: () => 'renderer.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
