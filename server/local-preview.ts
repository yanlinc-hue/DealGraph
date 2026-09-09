import type { Plugin } from 'vite';
import { handleRequest } from './worker.ts';
import { createLocalTransport } from './local-transport.ts';

type LocalPreviewOptions = {
  timeoutMs?: number;
  /** Local test seams only; no option can be supplied by an HTTP request. */
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  createTransport?: typeof createLocalTransport;
  handle?: typeof handleRequest;
};

async function untilAborted<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('Local request aborted');
  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Local request aborted')); });
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw new Error('Local request aborted'); return action(); }), interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Dev-only bridge. Never bundled into the browser or deployed Worker. */
export function localRelationshipApi(options: LocalPreviewOptions = {}): Plugin {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('本地请求超时必须为 1–300000 毫秒。');
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); });
  return { name: 'loopback-relationship-api', apply: 'serve', configureServer(server) {
    const transport = (options.createTransport ?? createLocalTransport)();
    server.httpServer?.once('close', () => { void transport.close(); });
    const windows = new Map<string, { at: number; count: number }>();
    const limiter = { async limit({ key }: { key: string }) { const now = Date.now(); let state = windows.get(key); if (!state || now - state.at > 60_000) { state = { at: now, count: 0 }; windows.set(key, state); } return { success: ++state.count <= 12 }; } };
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/relationships')) return next();
      const host = `127.0.0.1:${server.config.server.port}`, localOrigin = `http://${host}`;
      const remote = req.socket.remoteAddress;
      const allowed = (remote === '127.0.0.1' || remote === '::ffff:127.0.0.1') && req.headers.host === host
        && !req.headers.forwarded && !req.headers['x-forwarded-host']
        && (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
        && (req.method === 'GET' && (!req.headers.origin || req.headers.origin === localOrigin) || req.method === 'POST' && req.headers.origin === localOrigin);
      if (!allowed) { res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":{"code":"ACCESS_DENIED"}}'); return; }
      const controller = new AbortController();
      let disconnected = false, timedOut = false;
      const disconnect = () => { disconnected = true; controller.abort(); };
      const responseClosed = () => { if (!res.writableEnded) disconnect(); };
      req.on('aborted', disconnect); res.on('close', responseClosed);
      const cancelTimeout = scheduleTimeout(() => {
        timedOut = true; controller.abort();
        if (disconnected || res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        // Flush the error before terminating an unfinished upload; destroying req first
        // would also destroy its socket and hide the timeout response from the browser.
        res.end('{"error":{"code":"ANALYSIS_TIMEOUT","message":"本地请求超时，本次结果未更新。"}}', () => { if (!req.complete && !req.destroyed) req.destroy(); });
      }, timeoutMs);
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1_048_576 || controller.signal.aborted) throw new Error('Invalid request'); chunks.push(Buffer.from(chunk)); }
        if (controller.signal.aborted) throw new Error('Local request aborted');
        const headers = new Headers({ Origin: 'https://dealgraph.example.com', 'CF-Connecting-IP': '127.0.0.1' });
        for (const name of ['content-type', 'content-length', 'content-encoding', 'authorization', 'x-dealgraph-client', 'x-dealgraph-contract', 'sec-fetch-site']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]!);
        const request = new Request(`https://dealgraph.example.com${req.url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal });
        const response = await untilAborted(controller.signal, () => (options.handle ?? handleRequest)(request, { APP_ORIGIN: 'https://dealgraph.example.com', API_LIMIT: limiter, GLOBAL_LIMIT: limiter }, transport.outbound));
        const payload = await untilAborted(controller.signal, async () => {
          if (req.url === '/api/relationships/diagnose' && response.ok) {
            const diagnosis = await response.json() as Record<string, unknown>;
            return Buffer.from(JSON.stringify({ ...diagnosis, route: transport.route }));
          }
          return Buffer.from(await response.arrayBuffer());
        });
        if (!controller.signal.aborted && !disconnected && !res.destroyed && !res.writableEnded) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(payload); }
      } catch {
        if (!timedOut && !disconnected && !res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":{"code":"REQUEST_FAILED"}}'); }
      }
      finally { cancelTimeout(); req.removeListener('aborted', disconnect); res.removeListener('close', responseClosed); }
    });
  } };
}
