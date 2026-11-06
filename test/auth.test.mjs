import test from 'node:test';
import assert from 'node:assert/strict';

import { rejectionForConnection } from '../lib/auth.js';

/** 造一个只带 headers 的最小请求。 */
function request(origin = 'http://127.0.0.1:3080') {
  return { headers: { host: '127.0.0.1:3080', origin } };
}

test('认证服务缺失时 fail closed（401）', () => {
  assert.equal(rejectionForConnection(undefined, request()), 401);
  assert.equal(rejectionForConnection(null, request()), 401);
  assert.equal(rejectionForConnection({}, request()), 401);
  assert.equal(rejectionForConnection({ requestRejection: 'nope' }, request()), 401);
});

test('认证服务放行时返回 0', () => {
  const connection = { requestRejection: () => undefined };
  assert.equal(rejectionForConnection(connection, request()), 0);
});

test('认证服务拒绝时原样返回 401 / 403', () => {
  assert.equal(rejectionForConnection({ requestRejection: () => 401 }, request()), 401);
  assert.equal(rejectionForConnection({ requestRejection: () => 403 }, request()), 403);
});

test('认证服务抛出异常时 fail closed（401）', () => {
  const connection = {
    requestRejection: () => {
      throw new Error('boom');
    },
  };
  assert.equal(rejectionForConnection(connection, request()), 401);
});

test('认证服务返回未知状态码时收敛为 401', () => {
  assert.equal(rejectionForConnection({ requestRejection: () => 500 }, request()), 401);
});

test('请求对象原样交给认证服务（保留 headers）', () => {
  let seen;
  const connection = {
    requestRejection: (input) => {
      seen = input;
      return undefined;
    },
  };
  const req = request('http://127.0.0.1:3080');
  rejectionForConnection(connection, req);
  assert.equal(seen, req);
});