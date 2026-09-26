import { spawnSync } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [ ['run', 'build'], ['test'], ['run', 'build', '-w', '@rtc/react-native-sdk'], ['pack', '-w', '@rtc/protocol', '--dry-run'], ['pack', '-w', '@rtc/sdk', '--dry-run'], ['pack', '-w', '@rtc/react-native-sdk', '--dry-run'] ]) {
  const result = spawnSync(npm, args, { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('JavaScript release checks passed. Native builds and real-device validation are separate required gates. Nothing was published.');
