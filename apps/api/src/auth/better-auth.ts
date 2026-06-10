import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createDb } from '@piplus/db/client';
import { authSchema } from '@piplus/db/schema';
import { getDbPath } from '../db-context';

let _auth: ReturnType<typeof betterAuth> | null = null;

export function getAuth() {
  if (_auth) return _auth;
  const db = createDb(`file:${getDbPath()}`);
  _auth = betterAuth({
    baseURL: (Bun.env.BETTER_AUTH_URL as string | undefined) ?? 'http://localhost:3001',
    database: drizzleAdapter(db as any, {
      provider: 'sqlite',
      schema: authSchema,
    }) as any,
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7, // 7 days
      },
    },
  }) as ReturnType<typeof betterAuth>;
  return _auth;
}
