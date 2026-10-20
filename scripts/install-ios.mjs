import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAssets } from './prepare-assets.mjs';
import {
  createDeviceListPlan,
  createInstallPlan,
  createSignedBuildPlan,
  devicesFromDevicectl,
  parseInstallArguments,
  readLocalSigningConfig,
  redactSigningArguments,
  resolveSigningOptions,
  resolveTargetDevice,
  validateBundleId,
  validateDeviceSelector,
  validateTeam,
} from './ios-options.mjs';
import { toolchainEnvironment } from './toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const localSigningPath = join(root, 'native/LocalSigning.xcconfig');

function printHelp() {
  console.log(`Build, sign and install Wisp Remote from source on one iPhone.

Usage:
  node scripts/install-ios.mjs --team <TEAM_ID> --bundle-id <ID> --device <UDID_OR_UNIQUE_NAME> [options]

Options:
  --team <TEAM_ID>        Your 10-character Apple Team ID.
  --bundle-id <ID>        A unique reverse-DNS bundle identifier.
  --device <value>        Exact device identifier or unique device name. Required.
  --allow-provisioning    Allow Xcode to contact Apple, update signing assets and register the device.
  --portable              Use redistributable project artwork and system fonts.
  --dry-run               Validate explicit input and show a redacted plan without reading local signing settings, preparing assets, discovering devices, building or installing.
  --help                  Show this help without accessing signing settings or devices.

If --team or --bundle-id is omitted, the command reads it from the ignored
native/LocalSigning.xcconfig file. Sign in to Xcode first. The phone must be
connected, unlocked and trusted, with Developer Mode enabled. Free Personal
Team installations expire on Apple's schedule and must be rebuilt periodically.`);
}

function replaceAll(value, secrets) {
  let output = value;
  for (const secret of secrets) if (secret) output = output.split(secret).join('<redacted>');
  return output;
}

function pipeRedacted(stream, destination, secrets) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const newline = pending.lastIndexOf('\n');
    if (newline >= 0) {
      destination.write(replaceAll(pending.slice(0, newline + 1), secrets));
      pending = pending.slice(newline + 1);
    }
  });
  stream.on('end', () => {
    if (pending) destination.write(replaceAll(pending, secrets));
  });
}

function run(command, args, { cwd = root, env, redactions = [], silent = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: silent ? 'ignore' : ['ignore', 'pipe', 'pipe'] });
    child.once('error', reject);
    if (!silent) {
      pipeRedacted(child.stdout, process.stdout, redactions);
      pipeRedacted(child.stderr, process.stderr, redactions);
    }
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `${command} stopped with signal ${signal}.` : `${command} exited with status ${code ?? 'unknown'}.`));
    });
  });
}

function shownCommand(command, args) {
  return [command, ...args].map(value => JSON.stringify(value)).join(' ');
}

function dryRun(options) {
  const device = validateDeviceSelector(options.device);
  if (options.team !== undefined) validateTeam(options.team);
  if (options.bundleId !== undefined) validateBundleId(options.bundleId);
  const team = options.team ?? '<from-local-signing-file>';
  const bundleId = options.bundleId ?? '<from-local-signing-file>';
  const build = createSignedBuildPlan({ root, team, bundleId, device: '<resolved-device-id>', allowProvisioning: options.allowProvisioning });
  const list = createDeviceListPlan({ jsonPath: '<temporary-json-file>' });
  const install = createInstallPlan({ device, appPath: build.appPath });
  console.log('Dry run: no local signing file, assets, devices, Xcode build, Apple service or phone was accessed.');
  console.log(`Resource profile: ${options.portable ? 'portable' : 'local'}`);
  console.log(`Signing team: ${options.team === undefined ? 'native/LocalSigning.xcconfig fallback (not read)' : '<redacted>'}`);
  console.log(`Bundle identifier: ${options.bundleId ?? 'native/LocalSigning.xcconfig fallback (not read)'}`);
  console.log(`Device selector: ${device}`);
  console.log(shownCommand(list.command, list.args));
  console.log(shownCommand(build.command, redactSigningArguments(build.args)));
  console.log(shownCommand(install.command, install.args));
}

async function discoverDevice(selector, env) {
  const directory = await mkdtemp(join(tmpdir(), 'wisp-remote-devices-'));
  const jsonPath = join(directory, 'devices.json');
  try {
    const plan = createDeviceListPlan({ jsonPath });
    try {
      await run(plan.command, plan.args, { env, silent: true });
    } catch {
      throw new Error('Xcode could not list physical iOS devices. Open Xcode once, then connect, unlock, pair and trust the phone.');
    }
    let payload;
    try {
      payload = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch {
      throw new Error('Xcode did not return a readable CoreDevice device list. Update or reopen Xcode and try again.');
    }
    return resolveTargetDevice(devicesFromDevicectl(payload), selector);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseInstallArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.dryRun) return dryRun(options);

  const local = options.team === undefined || options.bundleId === undefined
    ? await readLocalSigningConfig(localSigningPath)
    : {};
  const signing = resolveSigningOptions(options, local);
  const env = toolchainEnvironment();
  const target = await discoverDevice(signing.device, env);
  await prepareAssets({ profile: signing.portable ? 'portable' : 'local' });

  const build = createSignedBuildPlan({ root, ...signing, device: target.buildDestination });
  if (signing.allowProvisioning) console.log('Provisioning access enabled: Xcode may contact Apple, update signing assets and register this device.');
  try {
    await run(build.command, build.args, { cwd: build.cwd, env, redactions: [signing.team] });
  } catch {
    throw new Error('Signed iOS build failed. Review the redacted Xcode output. Sign in to Xcode first; rerun with --allow-provisioning only if Apple account access and device registration are intended.');
  }
  try {
    await access(build.appPath);
  } catch {
    throw new Error('The signed build completed without the expected WispRemote.app output.');
  }

  const install = createInstallPlan({ device: target.selector, appPath: build.appPath });
  try {
    await run(install.command, install.args, { env });
  } catch {
    throw new Error('Installation failed. Keep the phone connected and unlocked, accept Trust prompts, and confirm Developer Mode is enabled.');
  }
  console.log('Installed Wisp Remote on the selected iPhone. Launch it from the phone.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
