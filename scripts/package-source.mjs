import { mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { candidateFiles, isSourcePackageFile, inspectWorkingFile } from './source-files.mjs';
import { bundledFonts } from './font-resources.mjs';

// Explicit source allowlist; never archive the working directory wholesale.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/package-source.mjs\nCreates a source-only tar.gz, file-hash manifest and SHA256SUMS under ignored dist/. No upload, signing or publication.');
} else {
  if (args.length) throw new Error('Unknown option. Use --help.');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version.');
  const files = candidateFiles().filter(isSourcePackageFile);
  const findings = (await Promise.all(files.map(inspectWorkingFile))).flat();
  if (findings.length) { console.error(JSON.stringify({ result: 'FAIL', findings }, null, 2)); process.exitCode = 1; }
  else {
    const name = `wisp-remote-${version}-source`;
    const output = join('dist', `${name}-${Date.now()}`);
    const tree = join(output, name);
    await mkdir(tree, { recursive: true });
    const manifest = {};
    for (const path of files) {
      await mkdir(dirname(join(tree, path)), { recursive: true });
      await cp(path, join(tree, path));
      manifest[path] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
    for (const required of ['LICENSE', 'README.md', 'scripts/setup.sh', 'native/Config/Signing.xcconfig', 'assets/fonts/manifest.json', ...bundledFonts.keys(), ...[...bundledFonts.values()].map(font => font.license)]) await access(join(tree, required));
    await writeFile(join(output, 'SOURCE-MANIFEST.json'), JSON.stringify({ version, files: manifest }, null, 2) + '\n');
    execFileSync('/usr/bin/tar', ['-czf', join(output, `${name}.tar.gz`), '-C', output, name], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const sum = createHash('sha256').update(await readFile(join(output, `${name}.tar.gz`))).digest('hex');
    await writeFile(join(output, 'SHA256SUMS'), `${sum}  ${name}.tar.gz\n`);
    console.log(`Source package: ${output}\nFiles: ${files.length}\nNo private config, generated assets, dependencies or app bundles included.`);
  }
}
