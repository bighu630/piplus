import { createDb } from '@piplus/db/client';
import { users } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';

export type SeedUserCredentials = {
  email: string;
  password: string;
};

export type SeedUserResult = {
  userId: string;
  name: string;
};

export async function authenticateUser(dbPath: string, email: string, password: string): Promise<SeedUserResult> {
  const db = createDb(`file:${dbPath}`);
  const rows = await db.select({ id: users.id, passwordHash: users.passwordHash, name: users.name }).from(users).where(eq(users.email, email)).limit(1);

  if (rows.length === 0) throw new Error('invalid_credentials');

  const user = rows[0]!;
  const valid = Bun.password.verifySync(password, user.passwordHash);

  if (!valid) throw new Error('invalid_credentials');
  return { userId: user.id, name: user.name };
}
