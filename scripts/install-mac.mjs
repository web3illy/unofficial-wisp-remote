import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rename, access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { prepareAssets, portableCSS } from './prepare-assets.mjs';
import { readFile } from 'node:fs/promises';
import { toolchainEnvironment } from './toolchain.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const preview = args.includes('--preview');
const portable = args.includes('--portable');
let env;
const appName = preview ? 'Wisp Remote Preview' : 'Wisp Remote';
const build = join(root, `work/build/${appName}.app`);
const run = (cmd, args) => { const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env }); if (result.status !== 0) throw new Error(`Build step failed: ${cmd}`); };
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function stopInstalledCompanion(destination) {
  const executable = join(destination, 'Contents/MacOS/WispRemoteMenu');
  const result = spawnSync('/usr/bin/pgrep', ['-x', 'WispRemoteMenu'], { encoding: 'utf8' });
  for (const text of (result.stdout || '').trim().split('\n').filter(Boolean)) {
    if (!/^\d+$/.test(text)) throw new Error('Could not identify running companion. Quit Wisp Remote and retry.');
    const pid = Number(text);
    let command;
    try { command = execFileSync('/bin/ps', ['-p', text, '-o', 'comm='], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (command !== executable) continue; // Never stop original Wisp, a preview, or another checkout.
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (attempt === 29) throw new Error('Wisp Remote did not quit. Quit it from its menu and retry.');
      await delay(100);
    }
  }
}

async function main() {
  const accepted = new Set(['--install', '--preview', '--portable', '--no-launch', '--dry-run', '--help']);
  if (args.some(arg => !accepted.has(arg))) throw new Error('Unknown option. Use --help.');
  if (args.includes('--help')) { console.log('Usage: node scripts/install-mac.mjs [--install] [--portable] [--no-launch] [--dry-run] [--preview]\nDefault builds with bundled open-license fonts and companion artwork. --portable uses system fonts and project artwork. Installation replaces only your Wisp Remote, retaining a backup and pairing data.'); return; }
  if (preview && args.includes('--install')) throw new Error('Preview builds cannot be installed.');
  if (args.includes('--dry-run')) { console.log(`Plan: prepare ${portable ? 'portable' : 'bundled'} assets, build and verify an ad-hoc-signed Mac companion${args.includes('--install') ? ', quit only the installed companion, replace with backup' : ''}${args.includes('--install') && !args.includes('--no-launch') ? ', launch' : ''}. No action performed.`); return; }
  env = toolchainEnvironment();
  if (preview && process.argv.includes('--install')) throw new Error('Preview builds cannot be installed.');
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Building requires an Apple Silicon Mac, Node.js 24+ and Xcode. Running requires Wisp 0.2.7.');
  await access(join(root, 'node_modules/@number0/iroh')); await prepareAssets({ profile: portable ? 'portable' : 'local' });
  await rm(build, { recursive: true, force: true });
  const contents = join(build, 'Contents'), app = join(contents, 'Resources/app');
  await mkdir(join(contents, 'MacOS'), { recursive: true }); await mkdir(app, { recursive: true }); await mkdir(join(root, 'work/swift-module-cache'), { recursive: true });
  run('/usr/bin/swiftc', ['-swift-version', '5', ...(preview ? ['-D', 'MENU_PREVIEW'] : []), '-parse-as-library', '-module-cache-path', join(root, 'work/swift-module-cache'), join(root, 'native/MacMenu.swift'), join(root, 'native/MacMenuState.swift'), '-o', join(contents, 'MacOS/WispRemoteMenu')]);
  run('/usr/bin/swift', ['-module-cache-path', join(root, 'work/swift-module-cache'), join(root, 'scripts/render-mac-icons.swift'), join(root, 'public/wisp-assets'), join(contents, 'Resources')]);
  run('/usr/bin/iconutil', ['-c', 'icns', join(contents, 'Resources/Remote.iconset'), '-o', join(contents, 'Resources/Remote.icns')]);
  await rm(join(contents, 'Resources/Remote.iconset'), { recursive: true });
  for (const name of ['src', 'public', 'node_modules']) await cp(join(root, name), join(app, name), { recursive: true, filter: path => !/text-proof|demo-runtime|\/server\.js$|\/app\.js$|\/index\.html$|\/styles\.css$/.test(path) });
  await cp(join(root, 'package.json'), join(app, 'package.json'));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(join(root, name), join(app, name), { recursive: true });
  if (portable) for (const name of ['mobile.css', 'menu.css']) {
    const path = join(app, 'public', name);
    await writeFile(path, portableCSS(await readFile(path, 'utf8')));
  }
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.wisp-remote.${preview ? 'preview' : 'companion'}</string><key>CFBundleName</key><string>${appName}</string><key>CFBundleExecutable</key><string>WispRemoteMenu</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>19</string><key>CFBundleShortVersionString</key><string>0.4.2</string><key>CFBundleIconFile</key><string>Remote</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>14.5</string><key>WispNodePath</key><string>${xml(process.execPath)}</string></dict></plist>`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', build]);
  run('/usr/bin/codesign', ['--verify', '--strict', build]);
  if (process.argv.includes('--install')) {
    const destination = join(homedir(), 'Applications/Wisp Remote.app');
    await mkdir(join(homedir(), 'Applications'), { recursive: true });
    const staged = join(homedir(), `Applications/.Wisp Remote stage ${process.pid}.app`);
    const backup = join(root, `work/Wisp Remote backup ${Date.now()}.app`);
    if (await exists(staged)) throw new Error('A staged installation already exists. Inspect it before retrying.');
    let backedUp = false;
    try {
      await cp(build, staged, { recursive: true, errorOnExist: true, force: false });
      run('/usr/bin/codesign', ['--verify', '--strict', staged]);
      await stopInstalledCompanion(destination);
      if (await exists(destination)) { await rename(destination, backup); backedUp = true; }
      try { await rename(staged, destination); }
      catch (error) { if (backedUp) await rename(backup, destination); throw error; }
    } finally { await rm(staged, { recursive: true, force: true }); }
    console.log(`Installed: ${destination}`);
    if (backedUp) console.log(`Previous app retained: ${backup}`);
    if (!args.includes('--no-launch')) run('/usr/bin/open', [destination, '--args', '--show-menu']);
  } else console.log(`Built: ${build}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
