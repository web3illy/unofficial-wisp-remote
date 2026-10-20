import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TEAM_PATTERN = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return { value, consumed: 1 };
}

function setOnce(options, key, value, name) {
  if (options[key] !== undefined) throw new Error(`${name} may be provided only once.`);
  options[key] = value;
}

export function parseBuildArguments(argv) {
  const options = { device: false, portable: false, help: false };
  for (const argument of argv) {
    if (argument === '--device') options.device = true;
    else if (argument === '--portable') options.portable = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown iOS build option: ${argument}`);
  }
  return options;
}

export function parseInstallArguments(argv) {
  const options = {
    team: undefined,
    bundleId: undefined,
    device: undefined,
    allowProvisioning: false,
    portable: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--allow-provisioning') options.allowProvisioning = true;
    else if (argument === '--portable') options.portable = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--team' || argument.startsWith('--team=')) {
      const parsed = optionValue(argv, index, '--team');
      setOnce(options, 'team', parsed.value, '--team');
      index += parsed.consumed;
    } else if (argument === '--bundle-id' || argument.startsWith('--bundle-id=')) {
      const parsed = optionValue(argv, index, '--bundle-id');
      setOnce(options, 'bundleId', parsed.value, '--bundle-id');
      index += parsed.consumed;
    } else if (argument === '--device' || argument.startsWith('--device=')) {
      const parsed = optionValue(argv, index, '--device');
      setOnce(options, 'device', parsed.value, '--device');
      index += parsed.consumed;
    } else throw new Error(`Unknown iOS install option: ${argument}`);
  }
  return options;
}

export function validateTeam(team) {
  if (!TEAM_PATTERN.test(team || '')) throw new Error('Apple Team ID must be exactly 10 uppercase letters or digits. Find it in Xcode > Settings > Accounts.');
  return team;
}

export function validateBundleId(bundleId) {
  if (!BUNDLE_ID_PATTERN.test(bundleId || '') || bundleId.split('.').some(part => part.startsWith('-') || part.endsWith('-'))) {
    throw new Error('Bundle identifier must use reverse-DNS form, for example com.example.wisp-remote.');
  }
  return bundleId;
}

export function validateDeviceSelector(device) {
  if (!device || !device.trim()) throw new Error('A target is required. Pass --device with the exact device identifier or unique device name.');
  if (device.includes('\0') || device.includes('\n') || device.includes('\r')) throw new Error('Device selector must be a single line.');
  return device.trim();
}

export function parseLocalSigningConfig(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const match = line.match(/^(DEVELOPMENT_TEAM|PRODUCT_BUNDLE_IDENTIFIER)\s*=\s*([^/]+?)\s*(?:\/\/.*)?$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'DEVELOPMENT_TEAM') values.team = value.trim();
    else values.bundleId = value.trim();
  }
  return values;
}

export async function readLocalSigningConfig(path) {
  try {
    return parseLocalSigningConfig(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read local signing settings at ${path}.`);
  }
}

export function resolveSigningOptions(options, local = {}) {
  return {
    team: validateTeam(options.team ?? local.team),
    bundleId: validateBundleId(options.bundleId ?? local.bundleId),
    device: validateDeviceSelector(options.device),
    allowProvisioning: options.allowProvisioning,
    portable: options.portable,
  };
}

export function createUnsignedBuildPlan({ root, device = false }) {
  const sdk = device ? 'iphoneos' : 'iphonesimulator';
  return {
    command: '/usr/bin/xcodebuild',
    cwd: join(root, 'native'),
    args: [
      '-project', 'WispRemote.xcodeproj',
      '-target', 'WispRemote',
      '-configuration', 'Debug',
      '-sdk', sdk,
      '-arch', 'arm64',
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      `SUPPORTED_PLATFORMS=${sdk}`,
      `SYMROOT=${join(root, 'work/ios-build/Products')}`,
      `OBJROOT=${join(root, 'work/ios-build/Intermediates')}`,
      'build',
    ],
  };
}

export function createSignedBuildPlan({ root, team, bundleId, device, allowProvisioning = false }) {
  const products = join(root, 'work/ios-install/Products');
  const destination = validateDeviceSelector(device);
  const args = [
    '-project', 'WispRemote.xcodeproj',
    '-target', 'WispRemote',
    '-configuration', 'Debug',
    '-sdk', 'iphoneos',
    '-arch', 'arm64',
    '-destination', `id=${destination}`,
    'CODE_SIGN_STYLE=Automatic',
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGNING_REQUIRED=YES',
    `DEVELOPMENT_TEAM=${team}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    'SUPPORTED_PLATFORMS=iphoneos',
    `SYMROOT=${products}`,
    `OBJROOT=${join(root, 'work/ios-install/Intermediates')}`,
  ];
  if (allowProvisioning) args.push('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration');
  args.push('build');
  return {
    command: '/usr/bin/xcodebuild',
    cwd: join(root, 'native'),
    args,
    appPath: join(products, 'Debug-iphoneos/WispRemote.app'),
  };
}

function deviceName(device) {
  return device?.deviceProperties?.name ?? device?.name;
}

function deviceIdentifiers(device) {
  return [
    device?.identifier,
    device?.hardwareProperties?.udid,
    device?.hardwareProperties?.serialNumber,
    device?.hardwareProperties?.ecid,
    device?.connectionProperties?.dnsName,
  ].filter(value => value !== undefined && value !== null).map(String);
}

function isPhysicalIOSDevice(device) {
  const platform = device?.hardwareProperties?.platform ?? device?.deviceProperties?.platform ?? device?.platform;
  const reality = device?.hardwareProperties?.reality ?? device?.deviceProperties?.reality ?? device?.reality;
  return /^iOS$/i.test(String(platform || '')) && /^physical$/i.test(String(reality || ''));
}

export function devicesFromDevicectl(payload) {
  const devices = payload?.result?.devices;
  if (!Array.isArray(devices)) throw new Error('CoreDevice returned an unsupported device-list response. Update Xcode and try again.');
  return devices.filter(isPhysicalIOSDevice);
}

export function resolveTargetDevice(devices, selector) {
  const target = validateDeviceSelector(selector);
  const identifierMatches = devices.filter(device => deviceIdentifiers(device).includes(target));
  if (identifierMatches.length === 1) {
    const identifiers = deviceIdentifiers(identifierMatches[0]);
    const canonical = identifierMatches[0]?.hardwareProperties?.udid ?? identifierMatches[0]?.identifier ?? identifiers[0];
    return { device: identifierMatches[0], selector: String(canonical), buildDestination: String(canonical) };
  }
  if (identifierMatches.length > 1) throw new Error('More than one physical iOS device matched that identifier. Disconnect duplicates or pass a unique UDID.');

  const nameMatches = devices.filter(device => deviceName(device) === target);
  if (nameMatches.length === 1) {
    const identifiers = deviceIdentifiers(nameMatches[0]);
    if (identifiers.length === 0) throw new Error('The named iOS device has no installable identifier. Reconnect it and unlock it.');
    const canonical = nameMatches[0]?.hardwareProperties?.udid ?? nameMatches[0]?.identifier ?? identifiers[0];
    return { device: nameMatches[0], selector: String(canonical), buildDestination: String(canonical) };
  }
  if (nameMatches.length > 1) throw new Error('More than one physical iOS device has that name. Pass the exact UDID shown by Xcode instead.');
  throw new Error('No physical iOS device matched --device. Connect, unlock, pair and trust the phone, then try again.');
}

export function createDeviceListPlan({ jsonPath }) {
  return {
    command: '/usr/bin/xcrun',
    args: ['devicectl', '--quiet', '--timeout', '30', '--json-output', jsonPath, 'list', 'devices'],
  };
}

export function createInstallPlan({ device, appPath }) {
  return {
    command: '/usr/bin/xcrun',
    args: ['devicectl', '--timeout', '120', 'device', 'install', 'app', '--device', device, appPath],
  };
}

export function redactSigningArguments(args) {
  return args.map(argument => argument.startsWith('DEVELOPMENT_TEAM=') ? 'DEVELOPMENT_TEAM=<redacted>' : argument);
}

export async function preserveLegacySigning({ projectPath, localConfigPath, backupPath }) {
  const project = await readFile(projectPath, 'utf8');
  await mkdir(dirname(backupPath), { recursive: true });
  let backupCreated = false;
  try {
    await copyFile(projectPath, backupPath, constants.COPYFILE_EXCL);
    backupCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  try {
    await readFile(localConfigPath, 'utf8');
    return { backupCreated, localConfigCreated: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const team = project.match(/\bDEVELOPMENT_TEAM\s*=\s*([^;\s]+)\s*;/)?.[1];
  const bundleId = project.match(/\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+)\s*;/)?.[1];
  if (!team || !bundleId) return { backupCreated, localConfigCreated: false };
  validateTeam(team);
  validateBundleId(bundleId);
  await writeFile(localConfigPath, `// Local Apple signing settings. This file must remain untracked.\nDEVELOPMENT_TEAM = ${team}\nPRODUCT_BUNDLE_IDENTIFIER = ${bundleId}\n`, { flag: 'wx', mode: 0o600 });
  return { backupCreated, localConfigCreated: true };
}
