import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['public/mobile.js', 'public/account-settings.js', 'public/menu.js', ...['src', 'scripts'].flatMap(dir => readdirSync(dir).filter(name => /\.(js|mjs)$/.test(name)).map(name => `${dir}/${name}`))];
for (const file of files) if (spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0) process.exit(1);
console.log(`Syntax checked: ${files.length} JavaScript files.`);
