/**
 * Test-suite bootstrap (loaded via bunfig.toml [test].preload).
 *
 * Route tests historically relied on the x-user-id fallback in
 * middleware/auth.ts, which is now gated behind an explicit PIPLUS_DEV_AUTH=1
 * opt-in plus a non-production NODE_ENV. Opt the whole API test suite in here
 * so those tests keep exercising their handlers; the security behavior of the
 * gate itself (production rejection, missing flag) is covered by
 * middleware/auth.test.ts.
 *
 * APP_PASSWORD is pinned for the same reason: Bun auto-loads the developer's
 * untracked repo-root .env, so without pinning the suite silently runs in
 * password-protected mode on a machine that has one and in anonymous mode in
 * CI. ask-question.test.ts depended on that accident (it sent no identity at
 * all), which is why it passed for its author and failed here. Pinning makes
 * the auth mode identical everywhere: auth enabled + dev identities honored.
 * Tests that need to exercise "no password configured" delete the variable
 * themselves (auth-status.test.ts, auth/token.test.ts, ws/server.test.ts), so
 * this pin does not weaken them.
 */
Bun.env.PIPLUS_DEV_AUTH = '1';
Bun.env.APP_PASSWORD = 'test-secret';
