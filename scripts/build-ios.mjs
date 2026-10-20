import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareAssets } from './prepare-assets.mjs';
import { createUnsignedBuildPlan, parseBuildArguments } from './ios-options.mjs';
import { toolchainEnvironment } from './toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function printHelp() {
  console.log(`Build the iPhone client without signing.

Usage: node scripts/build-ios.mjs [--device] [--portable]

  --device    Build for the physical-device SDK. The result remains unsigned.
  --portable  Use neutral project artwork and system fonts.
  --help      Show this help without preparing assets or starting a build.`);
}

async function main() {
  const options = parseBuildArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const env = toolchainEnvironment();
  await prepareAssets({ profile: options.portable ? 'portable' : 'local' });
  const plan = createUnsignedBuildPlan({ root, device: options.device });
  const result = spawnSync(plan.command, plan.args, { cwd: plan.cwd, env, stdio: 'inherit' });
  if (result.error) throw new Error(`Could not start xcodebuild: ${result.error.message}`);
  if (result.status !== 0) throw new Error('Unsigned iOS build failed. Review the xcodebuild errors above.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
