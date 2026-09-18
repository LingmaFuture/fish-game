import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';

test('guest credentials store only hashes and identify original guest', () => {
  const store = new Store(':memory:');
  const guest = store.guest(); assert.equal(guest.token?.length, 64);
  assert.equal(store.identify(guest.token), guest.playerId);
  assert.equal(store.guest(guest.token).playerId, guest.playerId);
  const row = store.db.prepare('SELECT * FROM guests').get()!;
  assert.notEqual(row.token_hash, guest.token);
  assert.equal(store.identify('forged'), undefined); store.db.close();
});
test('events are deduplicated and expired data is cleaned', () => {
  const store = new Store(':memory:'); const guest = store.guest();
  store.event('match_started', guest.playerId, 'room', 'match', undefined, 'event-1');
  store.event('match_started', guest.playerId, 'room', 'match', undefined, 'event-1');
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM events').get()!.count, 1);
  store.db.exec('UPDATE guests SET expires_at = 0; UPDATE events SET server_timestamp = 0;'); store.cleanup();
  assert.equal(store.identify(guest.token), undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM events').get()!.count, 0); store.db.close();
});
