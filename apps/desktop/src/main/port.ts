import net from 'node:net';

const DEFAULT_API_PORT = 18321;
const PORT_ENV_VAR = 'PIPLUS_DESKTOP_PORT';

export async function getFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate free port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

/**
 * Check whether a specific port is available on the given host.
 * Returns true if the port can be bound, false if it is already in use.
 */
export async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Get a port with the following priority:
 * 1. Environment variable PIPLUS_DESKTOP_PORT (if set and available)
 * 2. Built-in default (18321) if available
 * 3. Random free port as fallback
 *
 * Returns an object with the port and a flag indicating whether
 * the preferred (stable) port was used.
 */
export async function getPreferredPort(
  host = '127.0.0.1',
): Promise<{ port: number; preferred: boolean }> {
  // 1. Try env var (must be an exact integer string, e.g. "18321")
  const envPort = process.env[PORT_ENV_VAR];
  if (envPort) {
    const trimmed = envPort.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed > 0 && parsed <= 65535) {
        if (await isPortAvailable(host, parsed)) {
          console.log(`[desktop] using preferred port from ${PORT_ENV_VAR}=${parsed}`);
          return { port: parsed, preferred: true };
        }
        console.warn(
          `[desktop] ${PORT_ENV_VAR}=${parsed} unavailable; falling back`,
        );
      } else {
        console.warn(
          `[desktop] ${PORT_ENV_VAR}=${trimmed} out of range 1-65535; ignoring`,
        );
      }
    } else {
      console.warn(
        `[desktop] ${PORT_ENV_VAR}=${JSON.stringify(envPort)} is not an integer; ignoring`,
      );
    }
  }

  // 2. Try built-in default
  if (await isPortAvailable(host, DEFAULT_API_PORT)) {
    console.log(`[desktop] using preferred API port ${DEFAULT_API_PORT}`);
    return { port: DEFAULT_API_PORT, preferred: true };
  }

  // 3. Fallback to random port
  const fallback = await getFreePort(host);
  console.warn(
    `[desktop] preferred API port ${DEFAULT_API_PORT} unavailable; ` +
      `falling back to random port ${fallback}; ` +
      `localStorage origin will differ across restarts`,
  );
  return { port: fallback, preferred: false };
}

export { DEFAULT_API_PORT, PORT_ENV_VAR };
