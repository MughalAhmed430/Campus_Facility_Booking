// Unit test for requireRole. It replaced the temporary /api/test/student and /api/test/admin
// routes, which existed only to prove role checks work; no route needs a specific role
// until the booking and admin modules, so the middleware is tested directly here.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { useTestEnvironment } from './helpers/test-server.js';

let requireRole;

before(async () => {
  useTestEnvironment(); // the middleware's imports read the configuration
  ({ requireRole } = await import('../src/middleware/auth.js'));
});

function run(middleware, user) {
  let nextCalled = false;
  middleware({ user }, {}, () => { nextCalled = true; });
  return nextCalled;
}

describe('requireRole', () => {
  test('lets a user with an allowed role through', () => {
    assert.equal(run(requireRole('admin'), { role: 'admin' }), true);
    assert.equal(run(requireRole('student', 'admin'), { role: 'student' }), true);
  });

  test('refuses a signed-in user with another role: 403 FORBIDDEN', () => {
    assert.throws(() => run(requireRole('admin'), { role: 'student' }), { statusCode: 403, code: 'FORBIDDEN' });
    assert.throws(() => run(requireRole('student'), { role: 'admin' }), { statusCode: 403, code: 'FORBIDDEN' });
  });

  test('refuses a request without a signed-in user: 401 AUTH_REQUIRED', () => {
    assert.throws(() => run(requireRole('student'), undefined), { statusCode: 401, code: 'AUTH_REQUIRED' });
  });
});
