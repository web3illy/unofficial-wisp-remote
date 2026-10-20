import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'assets/fonts/manifest.json'), 'utf8'));
// Reviewed files only: a licence/provenance record is not a blanket binary exception.
export const bundledFonts = new Map();
for (const font of manifest.fonts) {
  if (!/^[A-Za-z0-9-]+\.woff2$/.test(font.file) || !/^[a-f0-9]{64}$/.test(font.sha256)
      || !/^licenses\/[A-Za-z0-9][A-Za-z0-9.-]*\.txt$/.test(font.license) || !font.source?.startsWith('https://')
      || bundledFonts.has(`assets/fonts/${font.file}`)) throw new Error('Invalid bundled font manifest.');
  bundledFonts.set(`assets/fonts/${font.file}`, Object.freeze(font));
}
if (!bundledFonts.size) throw new Error('Bundled font manifest is empty.');

export function inspectFontBytes(path, bytes) {
  const font = bundledFonts.get(path);
  if (!font) return [{ category: 'unapproved font', path }];
  if (bytes.length > 512_000 || bytes.subarray(0, 4).toString('ascii') !== 'wOF2'
      || createHash('sha256').update(bytes).digest('hex') !== font.sha256) {
    return [{ category: 'bundled font differs from reviewed source', path }];
  }
  return [];
}

export async function copyBundledFonts(destination) {
  // No installed application, network request, font conversion or font cache needed.
  const verified = await Promise.all([...bundledFonts].map(async ([path, font]) => {
    const bytes = await readFile(join(root, path));
    if (inspectFontBytes(path, bytes).length) throw new Error(`Bundled font verification failed: ${font.file}`);
    await readFile(join(root, font.license));
    return [font.file, bytes];
  }));
  await mkdir(destination, { recursive: true });
  for (const [name, bytes] of verified) await writeFile(join(destination, name), bytes);
  return verified.length;
}
