import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createDeviceListPlan,
  createInstallPlan,
  createSignedBuildPlan,
  createUnsignedBuildPlan,
  devicesFromDevicectl,
  parseInstallArguments,
  preserveLegacySigning,
  resolveSigningOptions,
  resolveTargetDevice,
} from '../scripts/ios-options.mjs';

const root = new URL('../', import.meta.url).pathname;

test('explicit signing options override local defaults and reject unsafe shapes', () => {
  const parsed = parseInstallArguments([
    '--team=ABCDE12345',
    '--bundle-id', 'org.example.wisp-remote',
    '--device', '00008110-001234567890001E',
    '--portable',
    '--allow-provisioning',
  ]);
  assert.deepEqual(resolveSigningOptions(parsed, {
    team: 'ZZZZZ99999',
    bundleId: 'org.local.old',
  }), {
    team: 'ABCDE12345',
    bundleId: 'org.example.wisp-remote',
    device: '00008110-001234567890001E',
    allowProvisioning: true,
    portable: true,
  });
  assert.throws(() => parseInstallArguments(['--team', '--device', 'Phone']), /requires a value/);
  assert.throws(() => resolveSigningOptions({ ...parsed, bundleId: '../bad id' }), /reverse-DNS/);
  assert.throws(() => resolveSigningOptions({ ...parsed, team: 'short' }), /exactly 10/);
});

test('unsigned build behavior stays compatible and provisioning remains opt-in', () => {
  const simulator = createUnsignedBuildPlan({ root: '/repo' });
  const device = createUnsignedBuildPlan({ root: '/repo', device: true });
  assert.ok(simulator.args.includes('-sdk') && simulator.args.includes('iphonesimulator'));
  assert.ok(device.args.includes('-sdk') && device.args.includes('iphoneos'));
  assert.ok(device.args.includes('CODE_SIGNING_ALLOWED=NO'));

  const ordinary = createSignedBuildPlan({ root: '/repo', team: 'ABCDE12345', bundleId: 'org.example.remote', device: 'udid-a' });
  assert.equal(ordinary.args.includes('-allowProvisioningUpdates'), false);
  assert.deepEqual(ordinary.args.slice(ordinary.args.indexOf('-destination'), ordinary.args.indexOf('-destination') + 2), ['-destination', 'id=udid-a']);
  const provisioning = createSignedBuildPlan({ root: '/repo', team: 'ABCDE12345', bundleId: 'org.example.remote', device: 'udid-a', allowProvisioning: true });
  assert.ok(provisioning.args.includes('-allowProvisioningUpdates'));
  assert.ok(provisioning.args.includes('-allowProvisioningDeviceRegistration'));
  assert.deepEqual(createDeviceListPlan({ jsonPath: '/tmp/devices.json' }).args, [
    'devicectl', '--quiet', '--timeout', '30', '--json-output', '/tmp/devices.json', 'list', 'devices',
  ]);
  assert.deepEqual(createInstallPlan({ device: 'udid-a', appPath: '/tmp/WispRemote.app' }).args, [
    'devicectl', '--timeout', '120', 'device', 'install', 'app', '--device', 'udid-a', '/tmp/WispRemote.app',
  ]);
});

test('device selection requires an exact identifier or one unique physical iOS name', () => {
  const payload = { result: { devices: [
    { identifier: 'core-a', deviceProperties: { name: 'Personal iPhone' }, hardwareProperties: { platform: 'iOS', reality: 'physical', udid: 'udid-a' } },
    { identifier: 'core-b', deviceProperties: { name: 'Lab iPhone' }, hardwareProperties: { platform: 'iOS', reality: 'physical', udid: 'udid-b' } },
    { identifier: 'sim-a', deviceProperties: { name: 'Personal iPhone' }, hardwareProperties: { platform: 'iOS', reality: 'simulator', udid: 'sim-udid' } },
    { identifier: 'mac-a', deviceProperties: { name: 'Mac' }, hardwareProperties: { platform: 'macOS', reality: 'physical' } },
  ] } };
  const devices = devicesFromDevicectl(payload);
  assert.equal(devices.length, 2);
  assert.equal(resolveTargetDevice(devices, 'udid-b').selector, 'udid-b');
  assert.equal(resolveTargetDevice(devices, 'Personal iPhone').selector, 'udid-a');
  assert.throws(() => resolveTargetDevice(devices, 'Missing iPhone'), /No physical iOS device matched/);
  assert.throws(() => resolveTargetDevice([...devices, { ...devices[0], identifier: 'core-c' }], 'Personal iPhone'), /More than one/);
});

test('help and dry-run do not require Xcode and redact the explicit team', () => {
  const env = { ...process.env, DEVELOPER_DIR: '/definitely/not/xcode' };
  const help = spawnSync(process.execPath, ['scripts/install-ios.mjs', '--help'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const dryRun = spawnSync(process.execPath, [
    'scripts/install-ios.mjs', '--dry-run', '--team', 'ABCDE12345', '--bundle-id', 'org.example.remote', '--device', 'Personal iPhone',
  ], { cwd: root, env, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /no local signing file, assets, devices, Xcode build, Apple service or phone was accessed/i);
  assert.doesNotMatch(dryRun.stdout, /ABCDE12345/);
  assert.match(dryRun.stdout, /DEVELOPMENT_TEAM=<redacted>/);
});

test('legacy signing migration preserves a private local config and project backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wisp-signing-test-'));
  try {
    const projectPath = join(directory, 'project.pbxproj');
    const localConfigPath = join(directory, 'LocalSigning.xcconfig');
    const backupPath = join(directory, 'backup/project.pbxproj');
    const team = 'ABCDE12345';
    const source = `DEVELOPMENT_TEAM = ${team};\nPRODUCT_BUNDLE_IDENTIFIER = org.example.remote;\n`;
    await writeFile(projectPath, source);
    assert.deepEqual(await preserveLegacySigning({ projectPath, localConfigPath, backupPath }), {
      backupCreated: true,
      localConfigCreated: true,
    });
    assert.equal(await readFile(backupPath, 'utf8'), source);
    assert.match(await readFile(localConfigPath, 'utf8'), /DEVELOPMENT_TEAM = ABCDE12345/);
    assert.deepEqual(await preserveLegacySigning({ projectPath, localConfigPath, backupPath }), {
      backupCreated: false,
      localConfigCreated: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
