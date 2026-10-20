import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableCSS } from '../scripts/prepare-assets.mjs';
import { createPortableArtwork } from '../scripts/portable-artwork.mjs';
import { isSourcePackageFile, inspectWorkingFile } from '../scripts/source-files.mjs';
import { bundledFonts, inspectFontBytes, copyBundledFonts } from '../scripts/font-resources.mjs';

test('Mac help/dry run works without platform prerequisites and rejects invalid combinations', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/install-mac.mjs', ...args], { encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/nonexistent-xcode-for-dry-run' } });
  assert.equal(run('--help').status, 0);
  const dry = run('--install', '--portable', '--no-launch', '--dry-run');
  assert.equal(dry.status, 0); assert.match(dry.stdout, /No action performed/);
  assert.notEqual(run('--preview', '--install', '--dry-run').status, 0);
  assert.notEqual(run('--unknown', '--dry-run').status, 0);
});

test('portable CSS drops vendor font requests and keeps appearance rules', () => {
  const css = '@font-face{font-family:"Cormorant Garamond";src:url("/wisp-assets/font.woff2")}body{font-family:"Noto Sans",sans-serif;color:#fff}';
  const result = portableCSS(css);
  assert.doesNotMatch(result, /font-face|wisp-assets|Noto Sans|Cormorant/);
  assert.match(result, /body\{font-family:-apple-system,sans-serif;color:#fff\}/);
});

test('portable artwork contains only generated SVGs and supplies every connection state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-artwork-'));
  try {
    await createPortableArtwork(dir);
    const files = await readdir(dir);
    assert(files.every(name => name.endsWith('.svg')));
    for (const state of ['offline', 'connecting', 'online', 'closed']) {
      const svg = await readFile(join(dir, `remote-ghost-${state}.svg`), 'utf8');
      assert.match(svg, /<svg /); assert.doesNotMatch(svg, /(?:href=|<script|@font-face)/);
    }
    assert.match(await readFile(join(dir, 'remote-ios.svg'), 'utf8'), /<rect width="1024" height="1024"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public source package allowlist excludes private/build resources', () => {
  for (const path of ['AGENTS.md', 'PRD.md', 'docs/ui-sources.md', 'docs/runtime-contract.md', 'docs/public-release-audit.md', 'native/LocalSigning.xcconfig', 'work/result.app/a', 'native/WispRemote/Web/mobile.html', 'public/wisp-assets/a.svg', '.env', 'cert.p12', '../escape', 'ai-work/task/TASK.md']) assert.equal(isSourcePackageFile(path), false, path);
  for (const path of ['LICENSE', 'scripts/setup.sh', 'scripts/prepare-assets.mjs', 'scripts/remote-artwork.mjs', 'docs/installation.md', 'docs/provenance.md', 'docs/companion-contract.md', 'src/pairing.js', 'public/mobile.js', 'public/mobile.css', 'native/App/RootView.swift', 'native/Config/Signing.xcconfig', 'native/WispRemote.xcodeproj/project.pbxproj']) assert.equal(isSourcePackageFile(path), true, path);
});

test('bundled fonts build offline and only reviewed bytes can enter the source package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-fonts-'));
  try {
    assert.equal(await copyBundledFonts(dir), bundledFonts.size);
    assert.equal((await readdir(dir)).length, bundledFonts.size);
    for (const [path, font] of bundledFonts) {
      assert.equal(isSourcePackageFile(path), true, path);
      assert.deepEqual(await inspectWorkingFile(path), [], path);
      const source = await readFile(path);
      assert.deepEqual(await readFile(join(dir, font.file)), source);
      const altered = Buffer.from(source); altered[altered.length - 1] ^= 1;
      assert.equal(inspectFontBytes(path, altered)[0].category, 'bundled font differs from reviewed source');
      assert.match(await readFile(font.license, 'utf8'), /SIL OPEN FONT LICENSE/i);
    }
    for (const path of ['assets/fonts/Unknown.woff2', 'assets/fonts/AscellaPixel-Regular.otf', 'assets/fonts/private.key', 'assets/fonts/../secret.woff2']) {
      assert.equal(isSourcePackageFile(path), false, path);
      assert.equal(inspectFontBytes(path, Buffer.from('wOF2'))[0].category, 'unapproved font');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CSS font resources exist in the reviewed bundle and native allowlists', async () => {
  for (const [cssPath, nativePath] of [['public/mobile.css', 'native/App/RemoteWebView.swift'], ['public/menu.css', 'native/MacMenu.swift']]) {
    const css = await readFile(cssPath, 'utf8');
    const native = await readFile(nativePath, 'utf8');
    for (const [, filename] of css.matchAll(/wisp-assets\/([^"')]+\.(?:woff2|otf))/g)) {
      assert(bundledFonts.has(`assets/fonts/${filename}`), filename);
      assert(native.includes(`"${filename}"`), `${filename} not allowed by ${nativePath}`);
    }
    assert.doesNotMatch(css + native, /AscellaPixel-Regular|wisp-original\.png/);
  }
});

test('Xcode preparation works without optional arguments and stops before downloads on failed preflight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-setup-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await mkdir(join(dir, 'bin'));
    const script = join(dir, 'scripts/setup.sh');
    await writeFile(script, await readFile(new URL('../scripts/setup.sh', import.meta.url)));
    await writeFile(join(dir, 'bin/uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n', { mode: 0o755 });
    await writeFile(join(dir, 'bin/node'), '#!/bin/sh\n[ "$1" != "-e" ] || exit 0\nprintf "node %s\\n" "$*" >> "$SETUP_TEST_TRACE"\nif [ "$1" = scripts/doctor.mjs ]; then exit "${SETUP_TEST_PREFLIGHT:-0}"; fi\n', { mode: 0o755 });
    await writeFile(join(dir, 'bin/npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$SETUP_TEST_TRACE"\n', { mode: 0o755 });
    const trace = join(dir, 'trace');
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, SETUP_TEST_TRACE: trace };
    const run = (args = [], extra = {}) => spawnSync('/bin/bash', [script, 'prepare-ios', ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    const prepared = run();
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /open native\/WispRemote.xcodeproj/);
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), [
      'node scripts/doctor.mjs --skip-dependencies --ios',
      'npm ci --ignore-scripts --no-fund --no-audit',
      'node scripts/prepare-assets.mjs',
    ]);
    await writeFile(trace, '');
    const failed = run([], { SETUP_TEST_PREFLIGHT: '23' });
    assert.equal(failed.status, 23);
    assert.equal(await readFile(trace, 'utf8'), 'node scripts/doctor.mjs --skip-dependencies --ios\n');
    await writeFile(trace, '');
    assert.equal(run(['--dry-run']).status, 0);
    assert.equal(run(['--help']).status, 0);
    assert.equal(run(['--unknown']).status, 64);
    assert.equal(await readFile(trace, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('working-file audit identifies a credential category without returning its value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-audit-'));
  try {
    const path = join(dir, 'example.js');
    const synthetic = 'ghp_' + 'a'.repeat(36);
    await writeFile(path, `const example = '${synthetic}';`);
    const findings = await inspectWorkingFile(path);
    assert(findings.some(f => f.category === 'GitHub credential'));
    assert(!JSON.stringify(findings).includes(synthetic));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
