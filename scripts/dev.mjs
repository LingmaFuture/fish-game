import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import httpProxy from 'http-proxy';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const production = process.argv.includes('--production');
const port = Number(process.env.PORT ?? 3000), webPort = Number(process.env.WEB_PORT ?? 3001), gamePort = Number(process.env.GAME_PORT ?? 3002);
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
const env = { ...process.env, APP_ORIGIN: origin, GAME_PORT: String(gamePort), NODE_ENV: production ? 'production' : 'development' };
const children = [
  spawn(process.execPath, ['node_modules/next/dist/bin/next', production ? 'start' : 'dev', '-p', String(webPort), '-H', '127.0.0.1'], { stdio: 'inherit', env }),
  spawn(process.execPath, production ? ['dist/server/index.js'] : ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env }),
];
const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (_error, _req, res) => { if (res && 'writeHead' in res && !res.headersSent) { res.writeHead(503); res.end('服务启动中，请稍后刷新。'); } });
const target = url => `http://127.0.0.1:${url.startsWith('/socket.io') || url.startsWith('/api/') ? gamePort : webPort}`;
const server = createServer((req, res) => proxy.web(req, res, { target: target(req.url ?? '/') }));
server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head, { target: target(req.url ?? '/') }));
server.listen(port, '127.0.0.1', () => console.log(`\n开一局 → ${origin}\n`));
let closing = false;
function stop(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill('SIGTERM');
  proxy.close(); server.close(); setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
for (const child of children) child.on('exit', code => { if (!closing) stop(code ?? 1); });
server.on('error', error => { console.error(error.message); stop(1); });
