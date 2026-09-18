import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Engine } from './engine.js';
import { Store } from './store.js';
import { pack, contentSummary } from './content.js';
import { validatePack } from './content-model.js';
import { allowSocketRequest } from './socket-origin.js';
import type { Ack, Command } from '../shared/protocol.js';

const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
const production = process.env.NODE_ENV === 'production';
if (production) validatePack(pack, true);
const engine = new Engine();
const store = new Store(process.env.DATABASE_PATH ?? './data/kaiyiju.sqlite');
const cookieToken = (cookie = '') => cookie.split(';').map(p => p.trim()).find(p => p.startsWith('kyj_guest='))?.slice(10);
const ipLimits = new Map<string, { count: number; expires: number }>();
function allowIP(ip: string, max: number, category: string) {
  const key = `${category}:${ip}`, now = Date.now();
  const old = ipLimits.get(key);
  const entry = old && old.expires > now ? old : { count: 0, expires: now + 60_000 };
  entry.count++; ipLimits.set(key, entry); return entry.count <= max;
}
const http = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403); res.end('{}'); return; }
  const ip = req.socket.remoteAddress ?? 'unknown';
  const url = new URL(req.url ?? '/', origin);
  if (url.pathname === '/api/health') { res.end(JSON.stringify({ ok: true, rooms: engine.rooms.size, content: pack.version })); return; }
  if (!allowIP(ip, 180, 'http')) { res.writeHead(429); res.end('{}'); return; }
  if (url.pathname === '/api/content' && req.method === 'GET') {
    res.end(JSON.stringify(contentSummary)); return;
  }
  if (url.pathname === '/api/guest' && req.method === 'POST') {
    if (req.headers.origin !== origin) { res.writeHead(403); res.end('{}'); return; }
    const guest = store.guest(cookieToken(req.headers.cookie));
    if (guest.token) res.setHeader('Set-Cookie', `kyj_guest=${guest.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${production ? '; Secure' : ''}`);
    res.end(JSON.stringify({ playerId: guest.playerId })); return;
  }
  if (url.pathname.startsWith('/api/rooms/') && req.method === 'GET') {
    const code = url.pathname.split('/').at(-1)?.toUpperCase() ?? '';
    const room = engine.rooms.get(code);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ errorCode: 'ROOM_NOT_FOUND' })); return; }
    res.end(JSON.stringify({ roomCode: code, count: room.members.length, phase: room.phase, gameKey: room.gameKey })); return;
  }
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    const id = store.identify(cookieToken(req.headers.cookie));
    if (!id || req.headers.origin !== origin) { res.writeHead(403); res.end('{}'); return; }
    if (!allowIP(id, 5, 'feedback')) { res.writeHead(429); res.end('{}'); return; }
    let body = '', tooLarge = false;
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 2048) { tooLarge = true; res.writeHead(413); res.end('{}'); req.destroy(); } });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const { text } = JSON.parse(body);
        if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error();
        store.feedback(id, text.trim()); res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{}'); }
    }); return;
  }
  res.writeHead(404); res.end('{}');
});
const io = new Server(http, { maxHttpBufferSize: 2048, cors: { origin, credentials: true },
  allowRequest: (req, done) => done(null, allowSocketRequest(req, origin)),
});
const controls = new Map<string, string>();
io.use((socket, next) => {
  const playerId = store.identify(cookieToken(socket.request.headers.cookie));
  if (!playerId) { next(new Error('访客身份已过期，请刷新页面。')); return; }
  if (!allowIP(socket.handshake.address, 300, 'socket')) { next(new Error('连接过于频繁')); return; }
  socket.data.playerId = playerId; next();
});
const lastPublished = new Map<string, number>();
function publish(force = false) {
  for (const socket of io.sockets.sockets.values()) {
    const id = socket.data.playerId as string;
    const room = engine.find(id);
    if (!room) {
      if (socket.data.roomCode) { socket.emit('room:closed', { reason: '房间已结束或你已被移出，请重新创建或加入。' }); socket.data.roomCode = undefined; }
      continue;
    }
    socket.data.roomCode = room.roomCode;
    const key = `${socket.id}:${room.roomId}`;
    if (force || lastPublished.get(key) !== room.version) {
      socket.emit('room:snapshot', engine.snapshot(room, id)); lastPublished.set(key, room.version);
      if (room.phase === 'RESULTS') {
        socket.emit('match:result', room.result);
        store.event('match_finished', undefined, room.roomId, room.match?.matchId, room.result?.endReason, `finish:${room.match?.matchId}`);
      }
      if (room.phase === 'PLAYING') store.event('match_started', undefined, room.roomId, room.match?.matchId, undefined, `start:${room.match?.matchId}`);
    }
  }
}
const events = ['room:create', 'room:join', 'room:resume', 'room:ready', 'room:setGame', 'room:kick', 'room:leave', 'match:start', 'match:rematch', 'answer:submit', 'turn:pass'];
io.on('connection', socket => {
  const id = socket.data.playerId as string;
  const old = controls.get(id);
  if (old && old !== socket.id) io.sockets.sockets.get(old)?.emit('connection:replaced');
  controls.set(id, socket.id);
  for (const event of events) socket.on(event, (data: Command, callback?: (ack: Ack) => void) => {
    let ack: Ack;
    try {
      ack = controls.get(id) === socket.id
        ? engine.command(id, event, data)
        : { actionId: data?.actionId, ok: false, errorCode: 'CONNECTION_REPLACED' };
      if (ack.ok) {
        const name = ({ 'room:create': 'room_created', 'room:join': 'room_joined', 'match:rematch': 'rematch_started' } as Record<string, string>)[event];
        const room = engine.find(id);
        if (name) store.event(name, id, room?.roomId, room?.match?.matchId, undefined, `${id}:${data.actionId}`);
      }
    } catch (error) {
      console.error('Command failed', event, error instanceof Error ? error.message : 'unknown');
      ack = { actionId: data?.actionId ?? '', ok: false, errorCode: 'INTERNAL_ERROR' };
    }
    socket.emit('command:ack', ack);
    if (typeof callback === 'function') callback(ack);
    publish();
  });
  socket.on('disconnect', () => {
    for (const key of lastPublished.keys()) if (key.startsWith(`${socket.id}:`)) lastPublished.delete(key);
    if (controls.get(id) === socket.id) {
      controls.delete(id); engine.disconnect(id); store.event('disconnect', id, engine.find(id)?.roomId); publish();
    }
  });
});
setInterval(() => { engine.tick(); publish(); }, 100).unref();
setInterval(() => {
  store.cleanup();
  for (const [key, value] of ipLimits) if (value.expires < Date.now()) ipLimits.delete(key);
}, 60_000).unref();
http.listen(Number(process.env.GAME_PORT ?? 3002), '127.0.0.1', () => console.log('Game service ready'));
function shutdown() { io.emit('room:closed', { reason: '服务已重启，进行中的房间已结束。请稍后新建房间。' }); io.close(); http.close(); store.db.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
