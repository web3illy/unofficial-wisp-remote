import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { developerDirectory } from './toolchain.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/doctor.mjs [--portable] [--ios] [--skip-dependencies]\nRead-only environment checks. --ios also checks the iPhone SDK. --skip-dependencies checks prerequisites before npm ci. No credentials or device data are read.');
} else {
  if (args.some(arg => !['--portable', '--ios', '--skip-dependencies'].includes(arg))) throw new Error('Unknown option. Use --help.');
  const checks = [];
  const check = (name, ok, remedy = '') => { checks.push(ok); console.log(`${ok ? 'OK' : 'FIX'}  ${name}${ok || !remedy ? '' : `\n     ${remedy}`}`); };
  check('Apple Silicon macOS', process.platform === 'darwin' && process.arch === 'arm64', 'Use an Apple Silicon Mac; Intel and other platforms are not supported.');
  check('Node.js 24 or newer', Number(process.versions.node.split('.')[0]) >= 24, 'With Homebrew: brew install node@24; then: export PATH="$(brew --prefix node@24)/bin:$PATH"');
  if (process.platform === 'darwin') {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim().split('.').map(Number);
    check('macOS 14.5 or newer', version[0] > 14 || (version[0] === 14 && version[1] >= 5), 'Update macOS in System Settings.');
    try {
      const developer = developerDirectory();
      const env = { ...process.env, DEVELOPER_DIR: developer };
      const version = execFileSync('/usr/bin/xcodebuild', ['-version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      check('Xcode 26 or newer', Number(/Xcode (\d+)/.exec(version)?.[1]) >= 26, 'Install/update full Xcode. The Mac glass view requires the macOS 26 SDK; older macOS uses a runtime fallback.');
      try { execFileSync('/usr/bin/xcodebuild', ['-checkFirstLaunchStatus'], { env, stdio: 'ignore' }); check('Xcode first-run setup', true); }
      catch { check('Xcode first-run setup', false, 'Open Xcode and complete its license/component prompts yourself.'); }
      if (args.includes('--ios')) {
        try { execFileSync('/usr/bin/xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { env, stdio: 'ignore' }); check('iOS SDK', true); }
        catch { check('iOS SDK', false, 'In Xcode Settings > Components, install iOS Platform Support. A Simulator runtime is optional for a physical phone.'); }
      }
    } catch (error) { check('Full Xcode', false, error.message); }
    if (!args.includes('--portable')) {
      const plist = '/Applications/Wisp.app/Contents/Info.plist';
      let version;
      try { version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Missing/unreadable app. */ }
      check('Installed Wisp Desktop 0.2.7', version === '0.2.7', 'Install the supported Wisp release in /Applications. Do not bypass Runtime compatibility checks for another version.');
    }
  }
  if (!args.includes('--skip-dependencies')) check('Pinned npm dependencies', existsSync(new URL('../node_modules/@number0/iroh/package.json', import.meta.url)), 'Run: npm ci --ignore-scripts');
  console.log('\nNo Apple account, Keychain values, pairing state, or chats were inspected. iOS signing/trust is checked by Xcode when you install.');
  process.exitCode = checks.every(Boolean) ? 0 : 1;
}
