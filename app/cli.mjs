// 命令行跑一轮（和网页上点「立即运行」一样），给不想开网页、或想用 Windows 计划任务定时的情况用。
// 用法：node --disable-warning=ExperimentalWarning app/cli.mjs run      （npm run auto）
//       node --disable-warning=ExperimentalWarning app/cli.mjs status
// 退出码：0 跑完；2 被 B站 限制访问提前收尾；3 有步骤出错；1 没能开始或意外出错
import './tz.mjs'; // 必须第一个导入：Git Bash 带的 TZ=UTC 要在算任何日期之前纠正
import { paths, openStore, readLock } from './store.mjs';
import { bus, startRun, stopRun, markInterrupted, STEPS } from './runner.mjs';

const cmd = process.argv[2] ?? 'run';
const p = paths();
const db = openStore(p);

if (cmd === 'status') {
  const lock = readLock(p);
  const last = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
  console.log(`工作区：${p.root}`);
  console.log(lock ? `正在运行：${lock.runId}（进程号 ${lock.pid}）` : '没有在运行');
  if (last) console.log(`最近一轮：${last.run_id} ${last.status}${last.error ? `（${last.error}）` : ''}`);
  process.exit(0);
}
if (cmd !== 'run') {
  console.error('用法：node app/cli.mjs run | status');
  process.exit(1);
}

markInterrupted(db, p);
const title = Object.fromEntries(STEPS.map((s) => [s.id, s.title]));
const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
bus.on('event', (e) => {
  if (e.type === 'log') console.log(`${clock(e.ts)} ${e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·'} ${e.step ? `[${title[e.step]}] ` : ''}${e.msg}`);
});
let run;
try {
  run = startRun({ trigger: 'cli' });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
process.on('SIGINT', () => { console.log('正在停止…'); stopRun(); });
const status = await run.promise.catch((e) => { console.error(e); return 'failed'; });
process.exit({ done: 0, blocked: 2, partial: 3, stopped: 1, failed: 1 }[status] ?? 1);
