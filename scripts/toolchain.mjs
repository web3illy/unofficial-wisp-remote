import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function developerDirectory() {
  let selected = process.env.DEVELOPER_DIR;
  if (!selected) {
    try { selected = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Explain below. */ }
    if (!selected || !existsSync(`${selected}/usr/bin/xcodebuild`)) selected = '/Applications/Xcode.app/Contents/Developer';
  }
  if (!existsSync(`${selected}/usr/bin/xcodebuild`)) throw new Error('Full Xcode is required. Install Xcode from the Mac App Store, open it once, then run: sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer');
  return selected;
}

export function toolchainEnvironment() {
  return { ...process.env, DEVELOPER_DIR: developerDirectory() };
}
