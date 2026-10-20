import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}/work/swift-module-cache`, { recursive: true });
for (const [command, args] of [
  ['/usr/bin/swiftc', ['-swift-version', '5', '-D', 'MENU_TEST', '-parse-as-library', '-module-cache-path', 'work/swift-module-cache', 'native/MacMenu.swift', 'native/MacMenuState.swift', 'native/MenuTests.swift', '-o', 'work/mac-menu-tests']],
  [`${root}/work/mac-menu-tests`, []],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
