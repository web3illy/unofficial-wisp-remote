import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Vector interpretation of the owner's selected concept 02. One master keeps
// the portrait, native menu frames and both launcher icons visually identical.
export async function createRemoteArtwork(directory) {
  const background = '#100f0d';
  const ink = '#111217';
  const states = {
    offline: { color: ink },
    closed: { color: '#FF4D5A', highlight: '#FFC0C5' },
    connecting: { color: '#FFD43B', highlight: '#FFF4AC' },
    online: { color: '#20E878', highlight: '#B5FFD1' },
  };
  const head = 'M66.5 12C65.2 22.7 72.7 29.2 77.9 35.3C80.8 38.7 81 41.2 80.4 40.6C83.9 38.8 85.3 35.1 85.3 32.2C91.1 41.4 101.1 45.2 108.4 58.2C114.2 68.5 116.2 76.4 115.7 83.2C115.2 95.4 110.5 105.8 101.8 112.3H26.2C17.5 105.8 12.8 95.4 12.3 83.2C11.8 76.4 13.8 68.5 19.6 58.2C26.9 45.2 36.9 41.4 42.9 32.2C42.7 35.6 44.1 39.6 47.8 40.6C46.7 28.7 57.3 18.5 66.5 12Z';
  // Eyes sit below the overly raised draft; their 1.29 aspect ratio is a soft
  // vertical oval. Identical geometry in every frame avoids blinking jitter.
  const eyes = (attributes = '') => [43, 85].map(cx => `<ellipse cx="${cx}" cy="73" rx="6.8" ry="8.8" ${attributes}/>`).join('');
  const portrait = (state, outline = null) => {
    const { color, highlight } = states[state];
    const glow = highlight ? `<defs><radialGradient id="eye-glow"><stop offset="0" stop-color="${color}" stop-opacity=".7"/><stop offset=".52" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>${[43, 85].map(cx => `<ellipse cx="${cx}" cy="73" rx="11" ry="13" fill="url(#eye-glow)"/>`).join('')}` : '';
    const core = highlight ? eyes(`fill="${color}" stroke="${color}" stroke-width=".6"`) + [43, 85].map(cx => `<ellipse cx="${cx - 1.2}" cy="70.4" rx="2.5" ry="3.4" fill="${highlight}" opacity=".72"/>`).join('') : eyes(`fill="${ink}"`);
    const border = outline ? ` stroke="${outline}" stroke-width="1.3" stroke-linejoin="round"` : '';
    return `<path d="${head}" fill="#FFFFFF"${border}/>${glow}${core}<path d="M58 88C60.5 94.5 67.5 94.5 70 88" fill="none" stroke="${ink}" stroke-width="4.5" stroke-linecap="round"/>`;
  };
  const svg = (viewBox, content) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${content}</svg>`;
  // Approved launcher composition: 30% larger, centered, flat base at y=1024.
  // The portrait itself and every menu-bar frame remain unchanged.
  const appPortrait = state => `<g transform="translate(12.80 148.06) scale(7.8)">${portrait(state)}</g>`;
  const appLabel = '<text x="512" y="154" text-anchor="middle" fill="#FFC16D" font-family="Arial Rounded MT Bold, ArialRoundedMTBold" font-size="90" letter-spacing="18">UNOFFICIAL</text>';

  for (const state of Object.keys(states)) {
    await writeFile(join(directory, `remote-ghost-${state}.svg`), svg('8 8 112 112', portrait(state)));
    await writeFile(join(directory, `menu-dark-${state}.svg`), svg('8 8 112 112', portrait(state)));
    await writeFile(join(directory, `menu-light-${state}.svg`), svg('8 8 112 112', portrait(state, '#77746F')));
    // Fit the same square artwork inside the existing macOS icon footprint.
    // Clip to its rounded corners so the enlarged portrait cannot spill out.
    const macShape = '<rect x="44" y="44" width="936" height="936" rx="216"/>';
    const icon = svg('0 0 1024 1024', `<defs><clipPath id="app-mask">${macShape}</clipPath></defs><rect x="44" y="44" width="936" height="936" rx="216" fill="${background}"/><g clip-path="url(#app-mask)"><g transform="translate(44 44) scale(0.9140625)">${appLabel}${appPortrait(state)}</g></g>`);
    await writeFile(join(directory, `remote-app-${state}.svg`), icon);
    if (state === 'offline') await writeFile(join(directory, 'remote-app.svg'), icon);
  }

  // iOS applies its own rounded-square mask; keep the source fully opaque.
  await writeFile(join(directory, 'remote-ios.svg'), svg('0 0 1024 1024', `<rect width="1024" height="1024" fill="${background}"/>${appLabel}${appPortrait('offline')}`));
}
