import type { Config } from 'drizzle-kit';

const home = process.env.HOME ?? '/tmp';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? `file:${home}/.config/piplus/piplus.sqlite`,
  },
} satisfies Config;
