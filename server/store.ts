import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS guests (player_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, player_id TEXT, room_id TEXT, match_id TEXT, game_key TEXT, end_reason TEXT, server_timestamp INTEGER NOT NULL, app_version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, player_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    this.cleanup();
  }
  guest(token?: string): { playerId: string; token?: string } {
    const existing = this.identify(token);
    if (existing) return { playerId: existing };
    const fresh = randomBytes(32).toString('hex'), playerId = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO guests VALUES (?, ?, ?, ?)').run(playerId, hash(fresh), now, now + 30 * 86400_000);
    return { playerId, token: fresh };
  }
  identify(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const row = this.db.prepare('SELECT player_id FROM guests WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now());
    return row?.player_id as string | undefined;
  }
  event(name: string, playerId?: string, roomId?: string, matchId?: string, endReason?: string, eventId: string = randomUUID()) {
    this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(eventId, name, playerId ?? null, roomId ?? null, matchId ?? null, 'idiom', endReason ?? null, Date.now(), '0.1.0');
  }
  feedback(playerId: string, text: string) {
    this.db.prepare('INSERT INTO feedback VALUES (?, ?, ?, ?)').run(randomUUID(), playerId, text, Date.now());
    this.event('feedback_submitted', playerId);
  }
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM guests WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM events WHERE server_timestamp < ?').run(now - 30 * 86400_000);
    this.db.prepare('DELETE FROM feedback WHERE created_at < ?').run(now - 30 * 86400_000);
  }
}
