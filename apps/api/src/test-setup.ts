/**
 * Test-suite bootstrap (loaded via bunfig.toml [test].preload).
 *
 * Route tests historically relied on the x-user-id fallback in
 * middleware/auth.ts, which is now gated behind an explicit PIPLUS_DEV_AUTH=1
 * opt-in plus a non-production NODE_ENV. Opt the whole API test suite in here
 * so those tests keep exercising their handlers; the security behavior of the
 * gate itself (production rejection, missing flag) is covered by
 * middleware/auth.test.ts.
 */
Bun.env.PIPLUS_DEV_AUTH = '1';
