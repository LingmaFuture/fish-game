import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { Ack, Snapshot } from '../shared/protocol.js';
import { pack } from '../server/content.js';

const origin = process.env.TEST_ORIGIN ?? 'http://localhost:3000';
const clients: { socket: Socket; cookie: string; state?: Snapshot; replaced?: boolean }[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, ms = 8000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > ms) throw new Error(`Timeout: ${label}`); await delay(30); }
}
async function client(cookie?: string, transport: 'websocket' | 'polling' | 'upgrade' = 'websocket') {
  if (!cookie) {
    const response = await fetch(`${origin}/api/guest`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie')!;
    assert.ok(header.includes('HttpOnly') && header.includes('SameSite=Strict'));
    cookie = header.split(';')[0];
  }
  const item: typeof clients[number] = { socket: io(origin, {
    autoConnect: false,
    transports: transport === 'upgrade' ? ['polling', 'websocket'] : [transport],
    transportOptions: {
      // Match real browsers: polling GET has no Origin; WebSocket does.
      polling: { extraHeaders: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } },
      websocket: { extraHeaders: { Cookie: cookie, Origin: origin } },
    },
  }), cookie };
  clients.push(item);
  item.socket.on('room:snapshot', state => { item.state = state; });
  item.socket.on('connection:replaced', () => { item.replaced = true; });
  await new Promise<void>((resolve, reject) => { item.socket.once('connect', resolve); item.socket.once('connect_error', reject); item.socket.connect(); });
  return item;
}
async function act(c: typeof clients[number], event: string, payload: object = {}, actionId = randomUUID()) {
  const result: Ack = await c.socket.timeout(5000).emitWithAck(event, { actionId, ...payload });
  return result;
}
try {
  const summary = await (await fetch(`${origin}/api/content`)).json();
  assert.equal(summary.version, pack.version);
  assert.equal(summary.answerCount, pack.entries.length);
  assert.deepEqual(Object.keys(summary).sort(), ['answerCount', 'promptCount', 'status', 'version']);
  const host = await client(undefined, 'polling'), friend = await client(undefined, 'upgrade');
  assert.equal(host.socket.io.engine.transport.name, 'polling');
  await until(() => friend.socket.io.engine.transport.name === 'websocket', 'polling upgrades to websocket');
  const create = await act(host, 'room:create', { nickname: '联调房主', gameKey: 'idiom' }); assert.equal(create.ok, true);
  assert.equal((await act(friend, 'room:join', { nickname: '联调朋友', roomCode: create.roomCode })).ok, true);
  await until(() => host.state?.members.length === 2 && friend.state?.members.length === 2, 'two users joined');
  assert.notEqual(host.state!.me, friend.state!.me);
  assert.equal((await act(friend, 'match:start')).errorCode, 'FORBIDDEN');
  assert.equal((await act(host, 'match:start')).errorCode, 'NOT_READY');
  await act(friend, 'room:ready', { ready: true }); await act(host, 'match:start');
  await until(() => host.state?.phase === 'PLAYING' && friend.state?.phase === 'PLAYING', 'countdown to match');
  assert.equal(host.state!.match!.packVersion, pack.version);
  const spectator = await client();
  await act(spectator, 'room:join', { nickname: '联调观战', roomCode: create.roomCode });
  await until(() => !!spectator.state?.match, 'spectator snapshot');
  assert.equal(spectator.state!.match!.scores.length, 2);
  const round = host.state!.match!;
  assert.equal((await act(spectator, 'turn:pass', { matchId: round.matchId, roundId: round.roundId })).errorCode, 'NOT_YOUR_TURN');
  const actor = round.turnPlayerId === host.state!.me ? host : friend;
  const answer = pack.entries.find(e => e.text.includes(round.prompt))!.text;
  const actionId = randomUUID(), payload = { matchId: round.matchId, roundId: round.roundId, answer };
  const first = await act(actor, 'answer:submit', payload, actionId);
  assert.equal(first.ok, true); assert.deepEqual(await act(actor, 'answer:submit', payload, actionId), first);
  await until(() => host.state?.match?.stage === 'TURN' && host.state.match.roundId !== round.roundId, 'next turn');
  for (let i = 0; i < 3; i++) {
    const turn = host.state!.match!;
    const current = turn.turnPlayerId === host.state!.me ? host : friend;
    assert.equal((await act(current, 'turn:pass', { matchId: turn.matchId, roundId: turn.roundId })).ok, true);
    await until(() => host.state?.phase === 'RESULTS' || (host.state?.match?.stage === 'TURN' && host.state.match.roundId !== turn.roundId), 'pass advances');
  }
  assert.equal(host.state!.phase, 'RESULTS'); assert.equal(host.state!.result!.endReason, 'last_standing');
  assert.equal((await act(host, 'match:rematch')).ok, true);
  await until(() => host.state?.phase === 'WAITING', 'rematch');
  assert.ok(host.state!.members.every(m => !m.ready));
  const replacement = await client(host.cookie);
  await until(() => !!host.replaced, 'single controller replacement');
  assert.equal((await act(host, 'room:ready', { ready: true })).errorCode, 'CONNECTION_REPLACED');
  assert.equal((await act(replacement, 'room:resume')).ok, true);
  await until(() => !!replacement.state, 'replacement resumes');
  assert.equal(replacement.state!.me, host.state!.me);
  assert.ok(!JSON.stringify(replacement.state).includes('guestToken'));
  assert.ok(!JSON.stringify(replacement.state).includes('answerId'));
  assert.equal((await fetch(`${origin}/api/guest`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${origin}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example', Cookie: host.cookie } })).status, 403);
  assert.equal((await fetch(`${origin}/socket.io/?EIO=4&transport=polling`, { headers: { 'Sec-Fetch-Site': 'cross-site', Cookie: host.cookie } })).status, 403);
  await act(replacement, 'room:leave'); await act(friend, 'room:leave'); await act(spectator, 'room:leave');
  console.log('Socket.IO 集成验证通过：无 Origin 同源轮询、WebSocket 升级及直连、跨站拒绝、独立访客、房间同步、权限、准备、倒计时、真实作答、去重、观战、结算、复玩和连接接管。');
} finally { for (const c of clients) c.socket.disconnect(); }
