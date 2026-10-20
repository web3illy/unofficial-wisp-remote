import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Project-authored device glyph for redistributable builds. No vendor artwork.
export async function createPortableArtwork(directory) {
  const colors = { offline: '#b5aea2', closed: '#ff4d5a', connecting: '#ffd43b', online: '#20e878' };
  const glyph = color => `<rect x="13" y="19" width="77" height="59" rx="8" fill="none" stroke="#fdf9ef" stroke-width="7"/><path d="M37 79v15m-16 0h39" fill="none" stroke="#fdf9ef" stroke-width="7" stroke-linecap="round"/><rect x="77" y="48" width="36" height="64" rx="8" fill="#100f0d" stroke="#fdf9ef" stroke-width="7"/><circle cx="95" cy="95" r="6" fill="${color}"/>`;
  const svg = (box, content) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${content}</svg>`;
  for (const [state, color] of Object.entries(colors)) {
    for (const name of [`remote-ghost-${state}`, `menu-dark-${state}`, `menu-light-${state}`]) {
      await writeFile(join(directory, `${name}.svg`), svg('0 0 128 128', glyph(color)));
    }
    const app = svg('0 0 1024 1024', `<rect x="44" y="44" width="936" height="936" rx="216" fill="#100f0d"/><g transform="translate(128 128) scale(6)">${glyph(color)}</g>`);
    await writeFile(join(directory, `remote-app-${state}.svg`), app);
    if (state === 'offline') await writeFile(join(directory, 'remote-app.svg'), app);
  }
  await writeFile(join(directory, 'remote-ios.svg'), svg('0 0 1024 1024', `<rect width="1024" height="1024" fill="#100f0d"/><g transform="translate(128 128) scale(6)">${glyph(colors.offline)}</g>`));
}
