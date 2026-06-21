export type PiSessionLocator = {
  piSessionId?: string;
  sessionFile: string;
};

export function stringifyLocator(locator: PiSessionLocator) {
  return JSON.stringify(locator);
}

export function parseLocator(raw: string): PiSessionLocator {
  const parsed = JSON.parse(raw) as Partial<PiSessionLocator>;
  if (!parsed || typeof parsed.sessionFile !== 'string' || !parsed.sessionFile) {
    throw new Error('invalid_pi_session_locator');
  }
  return {
    piSessionId: typeof parsed.piSessionId === 'string' ? parsed.piSessionId : undefined,
    sessionFile: parsed.sessionFile,
  };
}
