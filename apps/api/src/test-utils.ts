/**
 * Shared test utilities for the API test suite.
 */

/**
 * Temporarily sets APP_PASSWORD so a test exercises the password-protected
 * paths, then restores the previous value (or deletes it) afterwards.
 *
 * IMPORTANT: this helper must stay async and `await` the whole test body.
 * The Hono cors middleware defers response handling to a microtask, so a
 * synchronous env restore would let requireAuth read the already-restored
 * value and fail the test.
 */
export async function withPasswordAuth<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = Bun.env.APP_PASSWORD;
  Bun.env.APP_PASSWORD = 'test-secret';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete Bun.env.APP_PASSWORD;
    else Bun.env.APP_PASSWORD = prev;
  }
}
