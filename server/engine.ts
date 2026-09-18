import { createHash, randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Ack, Command, GameKey, Member, Phase, Result, Score, Snapshot } from '../shared/protocol.js';
import { choosePrompt, pack, validateAnswer } from './content.js';

const epoch = Date.now() - performance.now();
export const monotonicNow = () => epoch + performance.now();
type InternalMember = Member & { disconnectedAt?: number };
interface Match {
  matchId: string; roundId: string; stage: 'TURN' | 'FEEDBACK'; prompt: string;
  turnPlayerId: string; deadline: number; startAt: number; endAt: number;
  scores: Score[]; order: string[]; cursor: number; used: Set<string>; recent: string[];
  feedback?: string; packVersion: string;
}
export interface Room {
  roomId: string; roomCode: string; hostId: string; phase: Phase; version: number;
  members: InternalMember[]; banned: Set<string>; gameKey: GameKey; lastActionAt: number;
  countdownAt?: number; countdownIds?: string[]; match?: Match; result?: Result; idleWarning: boolean;
}
class CommandError extends Error { constructor(public code: string) { super(code); } }
const fail = (code: string): never => { throw new CommandError(code); };
export function cleanNickname(raw: unknown) {
  if (typeof raw !== 'string') return fail('NICKNAME_INVALID');
  const value = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().normalize('NFC');
  const length = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].length;
  if (length < 2 || length > 12) return fail('NICKNAME_INVALID');
  return value;
}
export class Engine {
  rooms = new Map<string, Room>();
  private receipts = new Map<string, { hash: string; ack: Ack; expires: number }>();
  private limits = new Map<string, number[]>();
  constructor(public now = monotonicNow, private random = Math.random) {}
  private bump(room: Room) { room.version++; }
  find(playerId: string) { return [...this.rooms.values()].find(r => r.members.some(m => m.playerId === playerId)); }
  private limit(key: string, max: number, period: number) {
    const times = (this.limits.get(key) ?? []).filter(t => this.now() - t < period);
    if (times.length >= max) return fail('RATE_LIMITED');
    times.push(this.now()); this.limits.set(key, times);
  }
  command(playerId: string, event: string, data: Command): Ack {
    const actionId = data?.actionId;
    if (typeof actionId !== 'string' || !/^[\w-]{8,80}$/.test(actionId)) return { actionId: '', ok: false, errorCode: 'BAD_INPUT' };
    const key = `${playerId}:${actionId}`;
    const hash = createHash('sha256').update(JSON.stringify([event, Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)))])).digest('hex');
    const cached = this.receipts.get(key);
    if (cached && cached.expires > this.now()) return cached.hash === hash ? cached.ack : { actionId, ok: false, errorCode: 'ACTION_CONFLICT' };
    let ack: Ack;
    try {
      this.limit(`${playerId}:all`, 30, 1000);
      if (event === 'answer:submit') this.limit(`${playerId}:answer`, 3, 1000);
      const room = this.execute(playerId, event, data);
      ack = { actionId, ok: true, stateVersion: room?.version, roomCode: room?.roomCode };
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      ack = { actionId, ok: false, errorCode: error.code, stateVersion: this.find(playerId)?.version };
    }
    if (ack.errorCode !== 'RATE_LIMITED') this.receipts.set(key, { hash, ack, expires: this.now() + 600_000 });
    return ack;
  }
  private execute(id: string, event: string, data: Command): Room | undefined {
    if (event === 'room:create') {
      this.limit(`${id}:create`, 3, 60_000);
      if (this.find(id)) return fail('ALREADY_IN_ROOM');
      if (data.gameKey && data.gameKey !== 'idiom') return fail('GAME_UNAVAILABLE');
      const nickname = cleanNickname(data.nickname);
      const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let code: string;
      do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (this.rooms.has(code));
      const room: Room = { roomId: randomUUID(), roomCode: code, hostId: id, phase: 'WAITING', version: 1,
        members: [{ playerId: id, nickname, joinedAt: this.now(), online: true, ready: false }],
        banned: new Set(), gameKey: 'idiom', lastActionAt: this.now(), idleWarning: false };
      this.rooms.set(code, room); return room;
    }
    if (event === 'room:join') {
      this.limit(`${id}:join`, 10, 60_000);
      const code = typeof data.roomCode === 'string' ? data.roomCode.toUpperCase().trim() : '';
      const room = this.rooms.get(code);
      if (!room || room.phase === 'CLOSED') return fail('ROOM_NOT_FOUND');
      if (room.banned.has(id)) return fail('BANNED');
      const previous = this.find(id);
      if (previous) return previous === room ? this.resume(id) : fail('ALREADY_IN_ROOM');
      if (room.members.length >= 8) return fail('ROOM_FULL');
      const base = cleanNickname(data.nickname);
      let nickname = base, index = 2;
      while (room.members.some(m => m.nickname === nickname)) nickname = `${base}·${index++}`;
      room.members.push({ playerId: id, nickname, joinedAt: this.now(), online: true, ready: false });
      room.lastActionAt = this.now(); this.bump(room); return room;
    }
    if (event === 'room:resume') return this.resume(id, data.roomCode);
    const room = this.find(id);
    if (!room || room.phase === 'CLOSED') return fail('ROOM_NOT_FOUND');
    const previousMatch = room.match;
    const deadlinePassed = previousMatch && (this.now() >= previousMatch.endAt || this.now() >= previousMatch.deadline);
    this.tickRoom(room);
    if (!this.rooms.has(room.roomCode)) return fail('ROOM_NOT_FOUND');
    const member = room.members.find(m => m.playerId === id);
    if (!member?.online) return fail('FORBIDDEN');
    const waiting = room.phase === 'WAITING' || room.phase === 'RESULTS';
    switch (event) {
      case 'room:leave': this.remove(room, id); break;
      case 'room:ready':
        if (!waiting || typeof data.ready !== 'boolean') return fail('WRONG_PHASE');
        member.ready = data.ready; break;
      case 'room:setGame':
        if (room.hostId !== id) return fail('FORBIDDEN');
        if (!waiting) return fail('WRONG_PHASE');
        if (data.gameKey !== 'idiom') return fail('GAME_UNAVAILABLE');
        room.gameKey = data.gameKey; room.members.forEach(m => { m.ready = false; }); break;
      case 'room:kick':
        if (room.hostId !== id || !data.playerId || data.playerId === id) return fail('FORBIDDEN');
        if (!waiting) return fail('WRONG_PHASE');
        if (!room.members.some(m => m.playerId === data.playerId)) return fail('BAD_INPUT');
        room.banned.add(data.playerId); this.remove(room, data.playerId); break;
      case 'match:rematch':
        if (room.phase !== 'RESULTS') return fail('WRONG_PHASE');
        if (room.hostId !== id) return fail('FORBIDDEN');
        room.phase = 'WAITING'; room.match = undefined; room.result = undefined;
        room.members.forEach(m => { m.ready = false; }); break;
      case 'match:start': {
        if (room.hostId !== id) return fail('FORBIDDEN');
        if (room.phase !== 'WAITING') return fail('WRONG_PHASE');
        const online = room.members.filter(m => m.online);
        if (online.length < 2 || online.some(m => m.playerId !== id && !m.ready)) return fail('NOT_READY');
        if (!choosePrompt(new Set(), [])) return fail('CONTENT_UNAVAILABLE');
        member.ready = true; room.phase = 'COUNTDOWN'; room.countdownAt = this.now() + 3000;
        room.countdownIds = online.map(m => m.playerId); break;
      }
      case 'answer:submit':
      case 'turn:pass': {
        if (deadlinePassed) return fail('TIMEOUT');
        const match = room.match;
        if (room.phase !== 'PLAYING' || !match) return fail('WRONG_PHASE');
        if (data.matchId !== match.matchId || data.roundId !== match.roundId) return fail('STALE_ROUND');
        if (match.stage !== 'TURN') return fail('STALE_ROUND');
        if (match.turnPlayerId !== id) return fail('NOT_YOUR_TURN');
        if (event === 'turn:pass') this.closeTurn(room, false, '主动放弃');
        else {
          if (typeof data.answer !== 'string' || data.answer.length > 100) return fail('BAD_INPUT');
          const validation = validateAnswer(data.answer, match.prompt, match.used);
          if (validation.errorCode || !validation.entry) return fail(validation.errorCode ?? 'NOT_INCLUDED');
          match.used.add(validation.entry.answerId);
          this.closeTurn(room, true, validation.entry.text);
        }
        break;
      }
      default: return fail('BAD_INPUT');
    }
    room.lastActionAt = this.now(); room.idleWarning = false; this.bump(room); return room;
  }
  resume(id: string, code?: string) {
    const room = this.find(id);
    if (room) this.tickRoom(room);
    if (!room || !this.rooms.has(room.roomCode) || !room.members.some(m => m.playerId === id) || (code && room.roomCode !== code)) return fail('ROOM_NOT_FOUND');
    const member = room.members.find(m => m.playerId === id)!;
    member.online = true; member.disconnectedAt = undefined;
    room.lastActionAt = this.now(); room.idleWarning = false; this.bump(room); return room;
  }
  disconnect(id: string) {
    const room = this.find(id); if (!room) return;
    const member = room.members.find(m => m.playerId === id)!;
    member.online = false; member.ready = false; member.disconnectedAt = this.now();
    if (room.phase === 'COUNTDOWN' && room.countdownIds?.includes(id)) { room.phase = 'WAITING'; room.countdownAt = undefined; room.countdownIds = undefined; }
    this.bump(room);
  }
  private remove(room: Room, id: string) {
    room.members = room.members.filter(m => m.playerId !== id);
    if (room.hostId === id) room.hostId = room.members.find(m => m.online)?.playerId ?? room.members[0]?.playerId ?? '';
    if (room.phase === 'COUNTDOWN' && room.countdownIds?.includes(id)) { room.phase = 'WAITING'; room.countdownAt = undefined; room.countdownIds = undefined; }
    const score = room.match?.scores.find(s => s.playerId === id);
    if (score && room.phase === 'PLAYING') {
      score.exited = true;
      if (!this.checkEnd(room) && room.match?.turnPlayerId === id) this.nextTurn(room);
    }
    if (!room.members.length) { room.phase = 'CLOSED'; this.rooms.delete(room.roomCode); }
    this.bump(room);
  }
  tick() {
    for (const room of this.rooms.values()) this.tickRoom(room);
    for (const [key, value] of this.receipts) if (value.expires <= this.now()) this.receipts.delete(key);
    for (const [key, values] of this.limits) if (this.now() - values.at(-1)! > 60_000) this.limits.delete(key);
  }
  private tickRoom(room: Room) {
    const now = this.now();
    for (const m of [...room.members]) if (!m.online && m.disconnectedAt !== undefined && now - m.disconnectedAt >= 30_000) this.remove(room, m.playerId);
    if (!this.rooms.has(room.roomCode)) return;
    if (now - room.lastActionAt >= 900_000) { room.phase = 'CLOSED'; this.rooms.delete(room.roomCode); this.bump(room); return; }
    if (now - room.lastActionAt >= 840_000 && !room.idleWarning) { room.idleWarning = true; this.bump(room); }
    if (room.phase === 'COUNTDOWN' && now >= room.countdownAt!) {
      const participants = room.members.filter(m => room.countdownIds?.includes(m.playerId));
      const order = participants.map(m => m.playerId);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      room.phase = 'PLAYING';
      room.match = { matchId: randomUUID(), roundId: '', stage: 'TURN', prompt: '', turnPlayerId: '', deadline: now,
        startAt: now, endAt: now + 180_000, scores: participants.map(m => ({ playerId: m.playerId, nickname: m.nickname, lives: 2, correct: 0, exited: false })),
        order, cursor: -1, used: new Set(), recent: [], packVersion: pack.version };
      this.nextTurn(room); this.bump(room);
    }
    const match = room.match;
    if (room.phase !== 'PLAYING' || !match) return;
    if (now >= match.endAt) { this.finish(room, 'time_limit'); return; }
    if (now >= match.deadline) {
      if (match.stage === 'TURN') this.closeTurn(room, false, '时间到');
      else this.nextTurn(room);
      this.bump(room);
    }
  }
  private nextTurn(room: Room) {
    const match = room.match!;
    if (this.checkEnd(room)) return;
    if (this.now() >= match.endAt) { this.finish(room, 'time_limit'); return; }
    const prompt = choosePrompt(match.used, match.recent, this.random);
    if (!prompt) { this.finish(room, 'content_exhausted'); return; }
    do { match.cursor = (match.cursor + 1) % match.order.length; }
    while (!match.scores.some(s => s.playerId === match.order[match.cursor] && s.lives > 0 && !s.exited));
    match.turnPlayerId = match.order[match.cursor]; match.roundId = randomUUID();
    match.stage = 'TURN'; match.prompt = prompt; match.recent.push(prompt); match.feedback = undefined;
    match.deadline = this.now() + (this.now() - match.startAt < 60_000 ? 12_000 : 9_000);
  }
  private closeTurn(room: Room, success: boolean, message: string) {
    const match = room.match!;
    if (match.stage !== 'TURN') return;
    const score = match.scores.find(s => s.playerId === match.turnPlayerId)!;
    if (success) score.correct++;
    else { score.lives--; if (score.lives === 0) score.eliminatedAt = this.now(); }
    match.stage = 'FEEDBACK'; match.feedback = success ? `${score.nickname} · ${message}，答对了！` : `${score.nickname} · ${message}，失去一条生命`;
    match.deadline = this.now() + (success ? 1000 : 2000);
    this.checkEnd(room);
  }
  private checkEnd(room: Room) {
    const active = room.match!.scores.filter(s => s.lives > 0 && !s.exited);
    if (active.length > 1) return false;
    this.finish(room, active.length === 0 ? 'no_players' : room.match!.scores.some(s => s.exited) ? 'opponents_left' : 'last_standing');
    return true;
  }
  private finish(room: Room, reason: Result['endReason']) {
    const rankings = room.match!.scores.map(s => ({ ...s })).sort((a, b) => Number(a.exited) - Number(b.exited) || b.lives - a.lives || (a.lives === 0 && b.lives === 0 ? (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0) : b.correct - a.correct));
    const best = rankings.find(s => !s.exited && s.lives > 0);
    const winnerIds = !best || reason === 'content_exhausted' || reason === 'no_players' ? [] : rankings.filter(s => !s.exited && s.lives === best.lives && s.correct === best.correct).map(s => s.playerId);
    room.result = { endReason: reason, rankings, winnerIds }; room.phase = 'RESULTS'; this.bump(room);
  }
  snapshot(room: Room, me: string): Snapshot {
    const m = room.match;
    return { roomId: room.roomId, roomCode: room.roomCode, hostId: room.hostId, phase: room.phase, version: room.version,
      serverNow: this.now(), me, members: room.members.map(({ disconnectedAt: _, ...member }) => ({ ...member })),
      gameKey: room.gameKey, countdownAt: room.countdownAt, result: room.result, idleWarning: room.idleWarning,
      match: m ? { matchId: m.matchId, roundId: m.roundId, stage: m.stage, prompt: m.prompt, turnPlayerId: m.turnPlayerId,
        deadline: m.deadline, endAt: m.endAt, scores: m.scores.map(s => ({ ...s })), feedback: m.feedback, packVersion: m.packVersion } : undefined };
  }
}
