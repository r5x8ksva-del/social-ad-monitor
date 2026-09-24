// B站公开接口的只读客户端。
// 规矩：游客身份、全局限速、每次请求都留痕（地址、状态、响应哈希），遇到风控就停手。
// 不做签名、不伪造设备、不换身份、不过验证码——任何「绕过技术措施」的事都不做。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// -412 请求被拦截，-352 风控校验失败，-509 / -799 请求过于频繁
const RISK_CODES = new Set([-412, -352, -509, -799]);

export class RiskError extends Error {}

export class BiliClient {
  constructor({ logPath, minIntervalMs = 1300, jitterMs = 700, maxRiskStreak = 3 }) {
    Object.assign(this, { logPath, minIntervalMs, jitterMs, maxRiskStreak });
    this.cookie = '';
    this.last = 0;
    this.riskStreak = 0;
    this.requests = 0;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  log(entry) {
    appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  // 只取首页发给每个访客的 buvid 等游客 cookie，不登录
  async init() {
    const res = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA } });
    await res.arrayBuffer();
    this.cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    this.log({ url: 'https://www.bilibili.com/', http: res.status, note: '取游客 cookie' });
  }

  async pace() {
    const gap = this.minIntervalMs + Math.random() * this.jitterMs;
    const elapsed = Date.now() - this.last;
    if (elapsed < gap) await new Promise((r) => setTimeout(r, gap - elapsed));
    this.last = Date.now();
  }

  // 返回解析后的 JSON；被拦就等一分钟重试一次，还不行返回 null；连续 maxRiskStreak 次出问题就抛 RiskError
  async getJson(url) {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const t0 = Date.now();
      let status = 0, body = '', json = null, error = null;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: this.cookie } });
        status = res.status;
        body = await res.text();
        try { json = JSON.parse(body); } catch {}
      } catch (e) {
        error = String(e).slice(0, 200);
      }
      this.requests++;
      this.log({ url, http: status, code: json?.code, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ms: Date.now() - t0, error });
      // 被拦：412 或风控码。出错：网络异常、其他非 200（比如 504）、响应不是 JSON。两种都重试一次。
      const blocked = status === 412 || RISK_CODES.has(json?.code);
      const failed = !blocked && (error || status !== 200 || !json);
      if (!blocked && !failed) {
        this.riskStreak = 0;
        return json;
      }
      this.riskStreak++;
      if (this.riskStreak >= this.maxRiskStreak) {
        throw new RiskError(`连续 ${this.riskStreak} 次被拦或出错（最后一次 http=${status} code=${json?.code} ${error ?? ''}），停手`);
      }
      if (attempt >= 1) return null;
      await new Promise((r) => setTimeout(r, blocked ? 60_000 : 10_000));
    }
  }
}
