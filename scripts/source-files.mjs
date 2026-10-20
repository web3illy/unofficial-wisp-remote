import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { bundledFonts, inspectFontBytes } from './font-resources.mjs';

export const excludedResource = /^(?:work|dist|node_modules|public\/wisp-assets|native\/WispRemote\/(?:Web|Assets\.xcassets))(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|LocalSigning\.xcconfig)$|\.(?:png|jpe?g|woff2?|otf|ttf|zip|ipa|mobileprovision|p12|pem|key|sqlite|db)$/i;
export const contentRules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['service credential', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{25,}|AIza[A-Za-z0-9_-]{35})\b/],
  ['personal signing', /DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]{10}\s*;/],
  ['personal home path', /\/Users\/(?!Shared(?:\/|\b)|(?:example|user|username)\b)[A-Za-z0-9._-]+\//],
];

export function candidateFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
}

export function isSourcePackageFile(path) {
  if (bundledFonts.has(path)) return true;
  if (excludedResource.test(path) || path.includes('..') || path.startsWith('/')) return false;
  return /^(?:LICENSE|README\.md|ARCHITECTURE\.md|SECURITY\.md|CONTRIBUTING\.md|THIRD_PARTY_NOTICES\.md|package(?:-lock)?\.json|\.gitignore)$/.test(path)
    || /^(?:src|scripts|tests|licenses|\.github)\//.test(path)
    || /^assets\/fonts\/(?:manifest\.json|README\.md)$/.test(path)
    || /^docs\/(?:installation|troubleshooting|distribution|provenance|licensing-decisions|privacy-and-installation|security-review|mobile-contract|companion-contract|attachments-contract)\.md$/.test(path)
    || /^public\/(?:mobile\.(?:html|css|js)|menu\.(?:html|css|js)|account-settings\.(?:css|js))$/.test(path)
    || /^native\/(?:App\/|Sources\/|Tests\/|Config\/|WispRemote\.xcodeproj\/(?!.*xcuserdata)|Package\.(?:swift|resolved)$|MacMenu(?:State)?\.swift$|MenuTests\.swift$|README\.md$)/.test(path);
}

export async function inspectWorkingFile(path) {
  const findings = [];
  const stat = await lstat(path);
  if (!stat.isFile()) return [{ category: 'non-regular source file', path }];
  if (bundledFonts.has(path)) return inspectFontBytes(path, await readFile(path));
  if (excludedResource.test(path)) findings.push({ category: 'excluded resource', path });
  if (stat.size > 512_000) return [...findings, { category: 'large file needs review', path }];
  const content = await readFile(path, 'utf8');
  for (const [category, pattern] of contentRules) if (pattern.test(content)) findings.push({ category, path });
  return findings;
}
