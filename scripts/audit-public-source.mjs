// Read-only publication check. Prints categories/paths, never matched contents.
// This is a focused guard, not a substitute for an independent security audit.
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
import { excludedResource as forbiddenPath, contentRules as signatures, candidateFiles, inspectWorkingFile } from './source-files.mjs';
import { bundledFonts, inspectFontBytes } from './font-resources.mjs';
const findings = [];
const checked = new Set();
function inspect(hash, path) {
  if (bundledFonts.has(path)) {
    // Validate every approved path, even when the same blob appeared elsewhere.
    // Read binary bytes, never UTF-8, and never print their contents.
    if (git('cat-file', '-t', hash).trim() !== 'blob' || Number(git('cat-file', '-s', hash)) > 512_000) {
      findings.push({ category: 'invalid bundled font object', path, object: hash }); return;
    }
    const bytes = execFileSync('git', ['cat-file', 'blob', hash], { maxBuffer: 512_000 });
    findings.push(...inspectFontBytes(path, bytes).map(finding => ({ ...finding, object: hash })));
    checked.add(hash);
    return;
  }
  if (forbiddenPath.test(path)) findings.push({ category: 'excluded resource', path, object: hash });
  if (checked.has(hash)) return;
  checked.add(hash);
  if (git('cat-file', '-t', hash).trim() !== 'blob') return;
  const size = Number(git('cat-file', '-s', hash));
  if (size > 512_000) { findings.push({ category: 'large blob needs review', path, object: hash }); return; }
  const content = git('cat-file', 'blob', hash);
  for (const [category, pattern] of signatures) if (pattern.test(content)) findings.push({ category, path, object: hash });
}
const staged = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
for (const entry of staged) {
  const [, , hash, , path] = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s) || [];
  if (hash) inspect(hash, path);
}
for (const entry of git('rev-list', '--objects', '--all').split('\n')) {
  const separator = entry.indexOf(' ');
  if (separator > 0) inspect(entry.slice(0, separator), entry.slice(separator + 1));
}
for (const path of candidateFiles()) findings.push(...await inspectWorkingFile(path));
const emails = [...new Set(git('log', '--all', '--format=%ae%n%ce').trim().split('\n'))];
if (emails.some(value => value !== 'noreply@github.com' && !value.endsWith('@users.noreply.github.com'))) findings.push({ category: 'commit email needs review' });
const origin = git('remote', 'get-url', 'origin').trim();
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(origin)) findings.push({ category: 'remote URL needs review' });
console.log(JSON.stringify({ result: findings.length ? 'FAIL' : 'PASS', indexEntries: staged.length, uniqueObjects: checked.size, findings }, null, 2));
if (findings.length) process.exitCode = 1;
