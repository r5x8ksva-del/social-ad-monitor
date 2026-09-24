// 火山方舟（OpenAI 兼容口）调用：关思考、温度 0（和研究版一致）。429 / 5xx / 网络错误重试，401 / 403 直接报出来。
import { MODELS } from '../../src/models.mjs';
import { sleep } from './media.mjs';

export class ArkAuthError extends Error {}

export async function chat({ model, content, maxTokens, signal, timeoutMs = 300_000, retries = 3 }) {
  if (!process.env.ARK_API_KEY) throw new ArkAuthError('没有设置环境变量 ARK_API_KEY（火山方舟的密钥）');
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(MODELS.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ARK_API_KEY}` },
        body: JSON.stringify({
          model, temperature: 0, thinking: { type: 'disabled' },
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          messages: [{ role: 'user', content }],
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json().catch(() => ({}));
      const error = j.error ? `${j.error.code ?? ''} ${j.error.message ?? ''}`.trim().slice(0, 300) : null;
      if (r.status === 401 || r.status === 403) throw new ArkAuthError(`方舟拒绝了请求（http ${r.status}）：${error ?? ''}。检查 ARK_API_KEY 和模型 ${model} 有没有开通`);
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status} ${error ?? ''}`);
      return { http: r.status, text: j.choices?.[0]?.message?.content ?? '', tokens: j.usage?.total_tokens ?? 0, error, ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof ArkAuthError || signal?.aborted) throw e;
      if (attempt > retries) return { http: 0, text: '', tokens: 0, error: String(e.message ?? e).slice(0, 300), ms: Date.now() - t0 };
      await sleep(4000 * attempt, signal);
    }
  }
}

// 并发跑一批：任何一个抛错（比如密钥无效）就不再领新任务，等在跑的结束后把错误抛出去
export async function pool(items, n, fn, signal) {
  let next = 0, failure = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      if (signal?.aborted) throw signal.reason ?? new Error('已停止');
      const item = items[next++];
      try { await fn(item); } catch (e) { failure ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failure) throw failure;
}
