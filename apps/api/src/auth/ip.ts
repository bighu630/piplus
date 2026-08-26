/**
 * Client IP resolution with reverse-proxy trust support.
 *
 * TRUST MODEL: `x-forwarded-for` is fully client-controlled. An untrusted
 * client can send arbitrary values, so XFF must only be honored when the
 * direct peer (the socket address that connected to us) is inside a trusted
 * proxy network — i.e. a reverse proxy we control that appends the real
 * client address. For untrusted peers the header is ignored entirely and the
 * peer IP is used as-is; when no trusted CIDRs are configured (default), XFF
 * is never consulted at all.
 */

/** Parses a comma-separated CIDR list ("127.0.0.1/32,10.0.0.0/8"). */
export function parseCidrs(str: string | undefined): string[] | undefined {
  if (str === undefined || str.trim() === '') return undefined;
  const cidrs = str
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  return cidrs.length > 0 ? cidrs : undefined;
}

function isIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && p.length <= 3 && Number(p) <= 255);
}

/**
 * Normalizes an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) to plain IPv4.
 * Returns the input unchanged otherwise.
 */
function normalizeMappedIPv4(ip: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match ? match[1] : ip;
}

function ipv4ToBits(ip: string): number | undefined {
  if (!isIPv4(ip)) return undefined;
  let bits = 0;
  for (const part of ip.split('.')) {
    bits = (bits << 8) | Number(part);
  }
  // Use >>> 0 to keep it an unsigned 32-bit integer.
  return bits >>> 0;
}

/**
 * Expands an IPv6 address to its 128-bit value.
 * Supports full, compressed (::) and mixed (x:x:x:x:x:x:d.d.d.d) notation.
 */
function ipv6ToBits(ip: string): bigint | undefined {
  // NOTE: do not normalizeMappedIPv4() here — stripping "::ffff:" off the
  // dotted form would leave a bare IPv4 string the group parser can't read.
  const addr = ip;

  // Dotted-quad IPv4-mapped form (::ffff:a.b.c.d): the address is exactly
  // 0xffff followed by the 32-bit IPv4 value — build it directly instead of
  // routing through the generic group parser below.
  const embedded = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (embedded) {
    const v4Bits = ipv4ToBits(embedded[1]);
    if (v4Bits === undefined) return undefined;
    return (0xffffn << 32n) | BigInt(v4Bits);
  }

  const halves = addr.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  if (head.some((g) => g === '' ) || tail.some((g) => g === '')) return undefined;

  const groups = [...head, ...tail];
  if (halves.length === 1 && groups.length !== 8) return undefined;
  if (halves.length === 2 && groups.length > 7) return undefined;

  const fill = 8 - groups.length;
  if (fill < 0) return undefined;

  const parseGroups = (gs: string[]): bigint | undefined => {
    let v = 0n;
    for (const g of gs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      v = (v << 16n) | BigInt(parseInt(g, 16));
    }
    return v;
  };

  const headVal = parseGroups(head);
  const tailVal = parseGroups(tail);
  if (headVal === undefined || tailVal === undefined) return undefined;

  // Head groups sit at the TOP of the 128-bit space; tail groups (after
  // "::") sit at the very BOTTOM, with the compressed zeros in between.
  const value = (headVal << BigInt(fill * 16 + tail.length * 16)) | tailVal;
  return value & ((1n << 128n) - 1n);
}

/**
 * Whether `ip` parses as a valid IPv4 or IPv6 address. Used to reject
 * garbage x-forwarded-for entries before they become rate-limit keys.
 */
export function isValidIp(ip: string): boolean {
  return isIPv4(normalizeMappedIPv4(ip)) || ipv6ToBits(ip) !== undefined;
}

/**
 * Whether `ip` falls inside `cidr`. Supports IPv4 prefix matching and IPv6
 * (including /128 exact matches and general prefix comparison); IPv4-mapped
 * IPv6 addresses are normalized and compared as IPv4 when the CIDR is IPv4.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/');
  const base = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefixRaw = slash === -1 ? undefined : cidr.slice(slash + 1);
  const prefix = prefixRaw === undefined || prefixRaw === '' ? undefined : Number(prefixRaw);
  if (prefix !== undefined && !Number.isInteger(prefix)) return false;

  const normalizedIp = normalizeMappedIPv4(ip);

  if (isIPv4(base)) {
    const baseBits = ipv4ToBits(base);
    const ipBits = ipv4ToBits(normalizedIp);
    if (baseBits === undefined || ipBits === undefined) return false;
    const p = prefix ?? 32;
    if (p < 0 || p > 32) return false;
    if (p === 0) return true;
    const mask = p === 32 ? 0xffffffff : (0xffffffff << (32 - p)) >>> 0;
    return (baseBits & mask) === (ipBits & mask);
  }

  // IPv6 CIDR: compare as 128-bit prefixes. Feed the ORIGINAL address so
  // IPv4-mapped forms (::ffff:a.b.c.d) keep their mapped layout; ipv6ToBits
  // expands both the dotted-quad and hex spellings identically.
  const baseBits = ipv6ToBits(base);
  const ipV6Bits = ipv6ToBits(ip);
  if (baseBits === undefined || ipV6Bits === undefined) return false;
  const p = prefix ?? 128;
  if (p < 0 || p > 128) return false;
  if (p === 0) return true;
  const shift = BigInt(128 - p);
  return baseBits >> shift === ipV6Bits >> shift;
}

export interface ResolveClientIpOptions {
  /** Raw x-forwarded-for header value (client-controlled). */
  xff?: string;
  /** Direct socket peer address of the connection. */
  peerIp?: string;
  /** CIDR list of trusted reverse proxies; absence disables XFF entirely. */
  trustedCidrs?: string[];
}

/**
 * Resolves the client IP behind optional trusted reverse proxies.
 *
 * - No peer address → 'unknown'.
 * - No trusted CIDRs configured, or the peer is not itself trusted → the peer
 *   IP verbatim (XFF ignored: an untrusted client could spoof it).
 * - Trusted peer → walk the XFF chain right-to-left, skipping addresses that
 *   belong to trusted proxy networks, and return the first non-trusted
 *   address (the outermost client). If every entry is trusted or the chain
 *   cannot be parsed, fall back to the peer IP.
 */
export function resolveClientIp(opts: ResolveClientIpOptions): string {
  const { xff, peerIp, trustedCidrs } = opts;
  if (!peerIp) return 'unknown';
  if (!trustedCidrs || trustedCidrs.length === 0) return peerIp;
  if (!trustedCidrs.some((cidr) => isIpInCidr(peerIp, cidr))) return peerIp;
  if (!xff) return peerIp;

  const chain = xff.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = chain[i];
    if (!trustedCidrs.some((cidr) => isIpInCidr(candidate, cidr))) {
      // Garbage entries (spoofed or malformed) must never become the client
      // identity — they would let an attacker rotate rate-limit keys at
      // will. Only a parseable IP is trusted; otherwise fall back to peer.
      return isValidIp(candidate) ? candidate : peerIp;
    }
  }
  // Every hop was a trusted proxy (or nothing parsed): fall back to the peer.
  return peerIp;
}
