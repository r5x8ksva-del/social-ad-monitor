// 媒体下载的小工具：可中止的等待、按 Range 分段下载（collect.mjs）、读 DASH 分片索引 sidx（m3-frames.mjs）。
// 研究版脚本里各有一份，留档不动；这里是自动监测用的，多了中止信号。

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('已停止'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('已停止')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const timeoutSignal = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

// 按 Range 分段取整个文件（播放器本身也是这样取的）；服务器不认 Range 就直接返回整文件。每段最多试 3 次。
// M2 里 100 分钟以上的音频整段下载两次都被中途断开，分成 4MB 一段就稳了。
export async function downloadRanges(src, headers, { chunk = 4 * 1024 * 1024, signal } = {}) {
  const parts = [];
  let start = 0, total = null, last = null;
  while (total === null || start < total) {
    let buf = null;
    for (let attempt = 1; ; attempt++) {
      try {
        last = await fetch(src, { headers: { ...headers, Range: `bytes=${start}-${start + chunk - 1}` }, signal: timeoutSignal(signal, 120_000) });
        buf = Buffer.from(await last.arrayBuffer());
        break;
      } catch (e) {
        if (signal?.aborted || attempt >= 3) throw e;
        await sleep(3000 * attempt, signal);
      }
    }
    if (last.status === 200) return { status: 200, buf };
    if (last.status !== 206 || !buf.length) break;
    total ??= Number(last.headers.get('content-range')?.split('/')[1] ?? NaN);
    parts.push(buf);
    start += buf.length;
    if (!Number.isFinite(total)) break;
  }
  return { status: parts.length ? 200 : last?.status ?? 0, buf: Buffer.concat(parts) };
}

// 取一段字节；服务器返回整文件（200）时截出需要的部分
export async function getRange(src, headers, a, b, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(src, { headers: { ...headers, Range: `bytes=${a}-${b}` }, signal: timeoutSignal(signal, 120_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status !== 206 && res.status !== 200) throw new Error(`http ${res.status}`);
      return res.status === 200 ? buf.subarray(a, b + 1) : buf;
    } catch (e) {
      if (signal?.aborted || attempt >= 3) throw e;
      await sleep(3000 * attempt, signal);
    }
  }
}

// ISO BMFF 的 sidx 盒子：每个分片的字节数和时长（B站 每片 5 秒）
export function parseSidx(buf) {
  let p = 8;
  const version = buf[p]; p += 4; p += 4;
  const timescale = buf.readUInt32BE(p); p += 4;
  let ept, firstOffset;
  if (version === 0) { ept = buf.readUInt32BE(p); firstOffset = buf.readUInt32BE(p + 4); p += 8; }
  else { ept = Number(buf.readBigUInt64BE(p)); firstOffset = Number(buf.readBigUInt64BE(p + 8)); p += 16; }
  p += 2;
  const count = buf.readUInt16BE(p); p += 2;
  const refs = [];
  let t = ept / timescale;
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32BE(p) & 0x7fffffff, d = buf.readUInt32BE(p + 4) / timescale;
    refs.push({ size, start: t, dur: d });
    t += d; p += 12;
  }
  return { firstOffset, refs };
}
