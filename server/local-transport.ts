import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { ENDPOINTS } from './model-adapters.ts';

/** Local development only. Proxy configuration never comes from an HTTP request. */
export function localProxyUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('本地代理仅接受 http://127.0.0.1:端口，不接受认证信息或远程代理。');
  }
  return parsed.origin;
}

export function createLocalTransport(value = process.env.DEALGRAPH_LOCAL_PROXY) {
  const proxyUrl = localProxyUrl(value);
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } }) : undefined;
  const destinations = new Set<string>(Object.values(ENDPOINTS).flatMap(item => [item.analyze, item.diagnose]));
  const outbound: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!destinations.has(url) || init?.redirect !== 'manual') throw new Error('不允许的模型请求目的地。');
    if (!dispatcher) return globalThis.fetch(input, init);
    // The Worker supplies only JSON request bodies and standard request headers.
    return await proxyFetch(url, { method: init.method, headers: init.headers as Record<string, string>, body: init.body as string | undefined, signal: init.signal, redirect: 'manual', dispatcher }) as unknown as Response;
  };
  return { outbound, route: proxyUrl ? 'system-proxy' as const : 'direct' as const, close: async () => { await dispatcher?.close(); } };
}
