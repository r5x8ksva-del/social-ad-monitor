// Git Bash 会给子进程带上 TZ=UTC，Node 就按 UTC 算「本地时间」，定时和日期全错 8 小时。
// 这里在别的模块之前运行：探一下系统时区（开一个不带 TZ 的子进程问），再设回去。delete process.env.TZ 不管用，赋值才生效。
import { execFileSync } from 'node:child_process';

if (process.env.TZ) {
  try {
    const env = { ...process.env };
    delete env.TZ;
    const zone = execFileSync(process.execPath, ['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
      { env, encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    if (zone) process.env.TZ = zone;
  } catch {
    // 探不到就保持原样
  }
}
