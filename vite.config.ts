import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localRelationshipApi } from './server/local-preview';

export default defineConfig(({ command }) => ({
  plugins: [react(), localRelationshipApi(), { name: 'privacy-csp', transformIndexHtml() {
    return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: `default-src 'self'; script-src 'self'${command === 'serve' ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'self'; base-uri 'self'; form-action 'none'` }, injectTo: 'head-prepend' }];
  } }],
  build: { sourcemap: false },
  server: { host: '127.0.0.1', fs: { deny: ['.env', '.env.*', '**/.git/**', '**/server/**', '**/*.key'] } },
}));
