import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine, cleanNickname } from '../server/engine.js';
import { pack, choosePrompt, validateAnswer } from '../server/content.js';
import type { Command } from '../shared/protocol.js';

function fixture(count = 2) {
  let now = 100_000;
  const engine = new Engine(() => now, () => 0.99);
  const act = (id: string, event: string, body: Partial<Command> = {}) => engine.command(id, event, { actionId: randomUUID(), ...body });
  const created = act('p1', 'room:create', { nickname: '玩家一' });
  const room = engine.rooms.get(created.roomCode!)!;
  for (let i = 2; i <= count; i++) {
    assert.equal(act(`p${i}`, 'room:join', { roomCode: room.roomCode, nickname: `玩家${i}` }).ok, true);
    act(`p${i}`, 'room:ready', { ready: true });
  }
  const advance = (ms: number, tick = true) => { now += ms; if (tick) engine.tick(); };
  const start = () => { assert.equal(act('p1', 'match:start').ok, true); advance(3000); };
  const turn = (event: string, body: Partial<Command> = {}) => act(room.match!.turnPlayerId, event, { matchId: room.match!.matchId, roundId: room.match!.roundId, ...body });
  return { engine, room, act, start, turn, advance };
}
test('2–12 graphemes, trim controls, room-scoped duplicate nicknames', () => {
  assert.equal(cleanNickname(' \n朋友👨‍👩‍👦 '), '朋友👨👩👦');
  assert.throws(() => cleanNickname('甲'));
  assert.throws(() => cleanNickname('一二三四五六七八九十一二三'));
  const f = fixture();
  f.act('p3', 'room:join', { roomCode: f.room.roomCode, nickname: '玩家一' });
  assert.equal(f.room.members[2].nickname, '玩家一·2');
});
test('six unambiguous characters; at most eight members; only host may start', () => {
  const f = fixture(8);
  assert.match(f.room.roomCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.equal(f.act('p9', 'room:join', { nickname: '第九人', roomCode: f.room.roomCode }).errorCode, 'ROOM_FULL');
  assert.equal(f.act('p2', 'match:start').errorCode, 'FORBIDDEN');
});
test('online players must be ready; disconnected players do not join match', () => {
  const f = fixture(3);
  f.act('p2', 'room:ready', { ready: false });
  assert.equal(f.act('p1', 'match:start').errorCode, 'NOT_READY');
  f.engine.disconnect('p2'); f.start();
  assert.deepEqual(f.room.match!.scores.map(s => s.playerId), ['p1', 'p3']);
});
test('disconnect during countdown cancels and clears readiness', () => {
  const f = fixture(); f.act('p1', 'match:start'); f.engine.disconnect('p2'); f.advance(3000);
  assert.equal(f.room.phase, 'WAITING'); assert.equal(f.room.members[1].ready, false);
});
test('countdown locks roster, late spectator disconnect does not cancel match', () => {
  const f = fixture(); f.act('p1', 'match:start');
  f.act('p3', 'room:join', { roomCode: f.room.roomCode, nickname: '迟到观战' });
  f.engine.disconnect('p3'); assert.equal(f.room.phase, 'COUNTDOWN'); f.advance(3000);
  assert.deepEqual(f.room.match!.scores.map(s => s.playerId), ['p1', 'p2']);
});
test('late joiner is spectator and cannot answer or prepare', () => {
  const f = fixture(); f.start(); f.act('p3', 'room:join', { nickname: '观战者', roomCode: f.room.roomCode });
  assert.equal(f.room.match!.scores.length, 2);
  assert.equal(f.act('p3', 'answer:submit', { matchId: f.room.match!.matchId, roundId: f.room.match!.roundId, answer: '马到成功' }).errorCode, 'NOT_YOUR_TURN');
  assert.equal(f.act('p3', 'room:ready', { ready: true }).errorCode, 'WRONG_PHASE');
});
test('successful answer adds one, closes once, idempotent retry and conflict', () => {
  const f = fixture(); f.start();
  const m = f.room.match!, id = m.turnPlayerId;
  const word = pack.entries.find(e => e.text.includes(m.prompt))!;
  const body = { actionId: randomUUID(), matchId: m.matchId, roundId: m.roundId, answer: word.text };
  const first = f.engine.command(id, 'answer:submit', body);
  assert.equal(first.ok, true); assert.equal(m.scores[0].correct, 1);
  assert.deepEqual(f.engine.command(id, 'answer:submit', body), first);
  assert.equal(m.scores[0].correct, 1);
  assert.equal(f.engine.command(id, 'answer:submit', { ...body, answer: '一马当先' }).errorCode, 'ACTION_CONFLICT');
  f.advance(1000);
  assert.equal(m.turnPlayerId, 'p2');
  assert.equal(f.act('p2', 'answer:submit', { matchId: m.matchId, roundId: body.roundId, answer: word.text }).errorCode, 'STALE_ROUND');
});
test('invalid answer stays private and never resets timer', () => {
  const f = fixture(); f.start(); const deadline = f.room.match!.deadline, version = f.room.version;
  f.advance(1000);
  assert.equal(f.turn('answer:submit', { answer: '测试测试' }).errorCode, 'NOT_INCLUDED');
  assert.equal(f.room.match!.deadline, deadline); assert.equal(f.room.version, version);
  const snapshot = JSON.stringify(f.engine.snapshot(f.room, 'p2'));
  assert.ok(!snapshot.includes('测试测试')); assert.ok(!snapshot.includes('used')); assert.ok(!snapshot.includes('answerId'));
});
test('deadline equality rejects submission and deducts exactly once', () => {
  const f = fixture(); f.start(); const m = f.room.match!, deadline = m.deadline;
  f.advance(deadline - f.engine.now(), false);
  const result = f.turn('answer:submit', { answer: pack.entries.find(e => e.text.includes(m.prompt))!.text });
  assert.equal(result.errorCode, 'TIMEOUT'); assert.equal(m.scores[0].lives, 1);
  f.engine.tick(); f.engine.tick(); assert.equal(m.scores[0].lives, 1); assert.equal(m.stage, 'FEEDBACK');
});
test('global deadline takes precedence without extra life deduction, equal scores tie', () => {
  const f = fixture(); f.start(); f.advance(180_000, false);
  assert.equal(f.turn('turn:pass').errorCode, 'TIMEOUT');
  assert.equal(f.room.result!.endReason, 'time_limit');
  assert.deepEqual(f.room.result!.winnerIds, ['p1', 'p2']);
  assert.equal(f.room.match!.scores[0].lives, 2);
});
test('turn duration locks at start, changes after 60s', () => {
  const f = fixture(); f.start(); const m = f.room.match!;
  assert.equal(m.deadline - f.engine.now(), 12_000);
  f.advance(59_000, false); f.engine.tick(); // one timeout, then feedback
  f.advance(2000);
  assert.equal(m.deadline - f.engine.now(), 9000);
});
test('elimination, results and rematch preserve room and reset scores/readiness', () => {
  const f = fixture(); f.start();
  f.turn('turn:pass'); f.advance(2000); f.turn('turn:pass'); f.advance(2000); f.turn('turn:pass');
  assert.equal(f.room.phase, 'RESULTS'); assert.deepEqual(f.room.result!.winnerIds, ['p2']);
  const code = f.room.roomCode;
  assert.equal(f.act('p1', 'match:rematch').ok, true);
  assert.equal(f.room.phase, 'WAITING'); assert.equal(f.room.roomCode, code); assert.equal(f.room.match, undefined);
  assert.ok(f.room.members.every(m => !m.ready));
});
test('reconnect restores same life and deadline without pausing', () => {
  const f = fixture(); f.start(); const deadline = f.room.match!.deadline;
  f.engine.disconnect('p1'); f.advance(10_000); f.act('p1', 'room:resume');
  assert.equal(f.room.match!.deadline, deadline); assert.equal(f.room.match!.scores[0].lives, 2);
  f.advance(2000); assert.equal(f.room.match!.scores[0].lives, 1);
});
test('host transfers at 30s once, old guest cannot reclaim by nickname', () => {
  const f = fixture(); f.engine.disconnect('p1'); f.advance(29_999); assert.equal(f.room.hostId, 'p1');
  f.advance(1); assert.equal(f.room.hostId, 'p2');
  assert.equal(f.act('p1', 'room:resume').errorCode, 'ROOM_NOT_FOUND');
  f.act('p1', 'room:join', { roomCode: f.room.roomCode, nickname: '玩家一' });
  assert.equal(f.room.hostId, 'p2');
});
test('voluntary host leave transfers immediately and opponent exit is identified', () => {
  const f = fixture(); f.start(); f.act('p1', 'room:leave');
  assert.equal(f.room.hostId, 'p2'); assert.equal(f.room.result!.endReason, 'opponents_left');
  assert.deepEqual(f.room.result!.winnerIds, ['p2']);
});
test('kicked visitor cannot rejoin and game changes clear ready flags', () => {
  const f = fixture(3);
  assert.equal(f.act('p2', 'room:kick', { playerId: 'p3' }).errorCode, 'FORBIDDEN');
  f.act('p1', 'room:setGame', { gameKey: 'idiom' }); assert.ok(f.room.members.every(m => !m.ready));
  f.act('p1', 'room:kick', { playerId: 'p2' });
  assert.equal(f.act('p2', 'room:join', { roomCode: f.room.roomCode, nickname: '换个名字' }).errorCode, 'BANNED');
});
test('room expires when everyone is offline for 30s or idle for 15m', () => {
  const f = fixture(); f.engine.disconnect('p1'); f.engine.disconnect('p2'); f.advance(30_000); assert.equal(f.engine.rooms.size, 0);
  const g = fixture(); g.advance(840_000); assert.equal(g.room.idleWarning, true);
  g.advance(60_000); assert.equal(g.engine.rooms.size, 0);
});
test('answer normalization, format errors, dictionary membership and used IDs', () => {
  assert.equal(validateAnswer(' 马到成功 ', '马', new Set()).entry?.text, '马到成功');
  assert.equal(validateAnswer('马 到成功', '马', new Set()).errorCode, 'ANSWER_FORMAT');
  assert.equal(validateAnswer('馬到成功', '马', new Set()).errorCode, 'NOT_INCLUDED');
  assert.equal(validateAnswer('马到成功', '水', new Set()).errorCode, 'PROMPT_MISMATCH');
  const id = validateAnswer('马到成功', '马', new Set()).entry!.answerId;
  assert.equal(validateAnswer('马到成功', '马', new Set([id])).errorCode, 'ALREADY_USED');
});
test('content exhaustion terminates without a champion', () => {
  assert.equal(choosePrompt(new Set(pack.entries.map(e => e.answerId)), []), undefined);
  const f = fixture(); f.start(); f.room.match!.used = new Set(pack.entries.map(e => e.answerId));
  f.turn('turn:pass'); f.advance(2000);
  assert.equal(f.room.result!.endReason, 'content_exhausted'); assert.deepEqual(f.room.result!.winnerIds, []);
});
test('three answers per second maximum and one guest one room', () => {
  const f = fixture(); f.start();
  for (let i = 0; i < 3; i++) assert.equal(f.turn('answer:submit', { answer: '测试测试' }).errorCode, 'NOT_INCLUDED');
  assert.equal(f.turn('answer:submit', { answer: '测试测试' }).errorCode, 'RATE_LIMITED');
  assert.equal(f.act('p1', 'room:create', { nickname: '重复建房' }).errorCode, 'ALREADY_IN_ROOM');
});
