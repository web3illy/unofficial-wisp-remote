import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRemoteArtwork } from './remote-artwork.mjs';
import { createPortableArtwork } from './portable-artwork.mjs';
import { toolchainEnvironment } from './toolchain.mjs';
import { copyBundledFonts } from './font-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function prepareAssets({ profile = 'local' } = {}) {
  if (!['local', 'portable'].includes(profile)) throw new Error('Unknown resource profile.');
  const env = toolchainEnvironment();
  const assets = join(root, 'public/wisp-assets');
  const web = join(root, 'native/WispRemote/Web');
  // Generated directories only. Never retain stale resources from an older build.
  await rm(assets, { recursive: true, force: true });
  await rm(web, { recursive: true, force: true });
  await mkdir(assets, { recursive: true });
  let fonts = 0;
  if (profile === 'portable') {
    await createPortableArtwork(assets);
  } else {
    fonts = await copyBundledFonts(assets);
    await createRemoteArtwork(assets);
  }
  await writeFile(join(assets, 'profile.json'), JSON.stringify({ profile }));
  await mkdir(web, { recursive: true });
  for (const name of ['mobile.js', 'mobile.css', 'account-settings.js', 'account-settings.css']) {
    let content = await readFile(join(root, 'public', name), 'utf8');
    if (profile === 'portable' && name.endsWith('.css')) content = portableCSS(content);
    await writeFile(join(web, name), content);
  }
  let html = await readFile(join(root, 'public/mobile.html'), 'utf8');
  html = html.replace('href="/mobile.css"', 'href="mobile.css"').replace('src="/mobile.js"', 'src="mobile.js"').replace('href="/account-settings.css"', 'href="account-settings.css"').replace('src="/account-settings.js"', 'src="account-settings.js"');
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`);
  await writeFile(join(web, 'mobile.html'), html);
  await cp(assets, join(web, 'wisp-assets'), { recursive: true });
  await cp(join(root, 'licenses'), join(web, 'licenses'), { recursive: true });
  await cp(join(root, 'LICENSE'), join(web, 'LICENSE.txt'));
  await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(web, 'THIRD_PARTY_NOTICES.txt'));
  const catalog = join(root, 'native/WispRemote/Assets.xcassets');
  const iconset = join(catalog, 'AppIcon.appiconset');
  await mkdir(iconset, { recursive: true });
  await mkdir(join(root, 'work/swift-module-cache'), { recursive: true });
  const rendered = spawnSync('/usr/bin/swift', ['-module-cache-path', join(root, 'work/swift-module-cache'),
    join(root, 'scripts/render-ios-icon.swift'), join(assets, 'remote-ios.svg'), join(iconset, 'AppIcon.png')],
    { env, stdio: 'inherit' });
  if (rendered.status !== 0) throw new Error('Could not render the local iPhone icon. Check Xcode and AppKit availability.');
  await writeFile(join(catalog, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2));
  await writeFile(join(iconset, 'Contents.json'), JSON.stringify({ images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }, null, 2));
  return { fonts, web, profile };
}
export function portableCSS(content) {
  return content.replace(/@font-face\s*\{[^}]*\}/g, '').replaceAll('"Cormorant Garamond"', 'ui-serif').replaceAll('"Noto Sans"', '-apple-system');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--portable')) throw new Error('Usage: node scripts/prepare-assets.mjs [--portable]');
  prepareAssets({ profile: args.includes('--portable') ? 'portable' : 'local' }).then(result => console.log(`Prepared ${result.fonts} bundled open-license fonts and native web assets.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
