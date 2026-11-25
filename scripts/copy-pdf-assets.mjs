import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
const source = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
const output = new URL('../dist/client/pdf-assets/', import.meta.url);
await mkdir(output, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts']) {
  await cp(
    fileURLToPath(new URL(`${directory}/`, source)),
    fileURLToPath(new URL(`${directory}/`, output)),
    { recursive: true },
  );
}
await cp(fileURLToPath(new URL('LICENSE', source)), fileURLToPath(new URL('LICENSE', output)));
