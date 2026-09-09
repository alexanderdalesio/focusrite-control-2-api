import test from 'node:test';
import assert from 'node:assert/strict';

import { authorizeApiRequest, isLoopback } from '../src/http-security.js';

test('loopback clients do not need a network token', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback(address), true);
    assert.doesNotThrow(() => authorizeApiRequest({ remoteAddress: address, bindHost: '127.0.0.1' }));
  }
});

test('remote clients require LAN mode and the exact bearer token', () => {
  const request = { remoteAddress: '192.168.1.50', bindHost: '0.0.0.0', accessToken: 'a'.repeat(64) };
  assert.throws(() => authorizeApiRequest({ ...request, bindHost: '127.0.0.1' }), (error) => error.statusCode === 403);
  assert.throws(() => authorizeApiRequest(request), (error) => error.statusCode === 401);
  assert.throws(() => authorizeApiRequest({ ...request, authorization: `Bearer ${'b'.repeat(64)}` }), (error) => error.statusCode === 401);
  assert.doesNotThrow(() => authorizeApiRequest({ ...request, authorization: `Bearer ${'a'.repeat(64)}` }));
});
