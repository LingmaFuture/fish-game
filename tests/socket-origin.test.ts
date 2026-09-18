import test from 'node:test';
import assert from 'node:assert/strict';
import { allowSocketRequest } from '../server/socket-origin.js';
import type { IncomingHttpHeaders } from 'node:http';

const origin = 'http://localhost:3000';
const request = (headers: IncomingHttpHeaders, transport = 'polling') => ({
  method: 'GET', url: `/socket.io/?EIO=4&transport=${transport}`, headers: { host: 'localhost:3000', ...headers },
});
test('same-origin browser polling may omit Origin', () => {
  assert.equal(allowSocketRequest(request({ 'sec-fetch-site': 'same-origin' }), origin), true);
  assert.equal(allowSocketRequest(request({ referer: `${origin}/?room=ABC234` }), origin), true);
});
test('polling and websocket permit the configured Origin', () => {
  for (const transport of ['polling', 'websocket']) assert.equal(allowSocketRequest(request({ origin }, transport), origin), true);
});
test('reject foreign and null Origins even with a matching Referer', () => {
  for (const foreign of ['https://evil.example', 'null', 'http://localhost:3001']) {
    assert.equal(allowSocketRequest(request({ origin: foreign, referer: origin }), origin), false);
  }
});
test('missing Origin requires same-origin evidence and exact host', () => {
  for (const headers of [{}, { referer: 'https://evil.example/' }, { referer: 'invalid' }, { 'sec-fetch-site': 'cross-site', referer: origin }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'same-origin', host: 'evil.example' }]) {
    assert.equal(allowSocketRequest(request(headers), origin), false);
  }
});
test('WebSocket cannot use the polling exception', () => {
  assert.equal(allowSocketRequest(request({ 'sec-fetch-site': 'same-origin', referer: origin }, 'websocket'), origin), false);
});
