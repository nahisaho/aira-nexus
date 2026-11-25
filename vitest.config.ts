import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export default defineConfig({
  cacheDir: '.vite-integration-cache',
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url))),
      ],
    },
  },
  test: {
    cache: false,
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 30000,
    hookTimeout: 120000,
    setupFiles: ['tests/setup.ts'],
  },
});
