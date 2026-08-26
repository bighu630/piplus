import { describe, expect, test } from 'bun:test';
import { isIpInCidr, isValidIp, parseCidrs, resolveClientIp } from './ip';

describe('parseCidrs', () => {
  test('splits a comma-separated list and trims whitespace', () => {
    expect(parseCidrs('127.0.0.1/32, ::1/128, 10.0.0.0/8')).toEqual([
      '127.0.0.1/32',
      '::1/128',
      '10.0.0.0/8',
    ]);
  });

  test('returns undefined for empty or missing input', () => {
    expect(parseCidrs(undefined)).toBeUndefined();
    expect(parseCidrs('')).toBeUndefined();
    expect(parseCidrs('   ')).toBeUndefined();
    // All-empty entries collapse to nothing → undefined (no trusted proxies).
    expect(parseCidrs(', ,')).toBeUndefined();
  });
});

describe('isIpInCidr', () => {
  test('IPv4 exact (/32) match', () => {
    expect(isIpInCidr('127.0.0.1', '127.0.0.1/32')).toBe(true);
    expect(isIpInCidr('127.0.0.2', '127.0.0.1/32')).toBe(false);
  });

  test('IPv4 prefix matching', () => {
    expect(isIpInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('192.168.2.5', '192.168.1.0/24')).toBe(false);
  });

  test('IPv4 without prefix means /32', () => {
    expect(isIpInCidr('1.2.3.4', '1.2.3.4')).toBe(true);
    expect(isIpInCidr('1.2.3.5', '1.2.3.4')).toBe(false);
  });

  test('IPv6 loopback /128 exact match', () => {
    expect(isIpInCidr('::1', '::1/128')).toBe(true);
    expect(isIpInCidr('::2', '::1/128')).toBe(false);
  });

  test('IPv6 prefix comparison', () => {
    expect(isIpInCidr('2001:db8:abcd:1::99', '2001:db8:abcd::/48')).toBe(true);
    expect(isIpInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    // Compressed notation on both sides.
    expect(isIpInCidr('fe80::1234', 'fe80::/10')).toBe(true);
  });

  test('IPv4-mapped IPv6 addresses are normalized to IPv4', () => {
    expect(isIpInCidr('::ffff:127.0.0.1', '127.0.0.1/32')).toBe(true);
    expect(isIpInCidr('::ffff:10.20.30.40', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('::ffff:11.20.30.40', '10.0.0.0/8')).toBe(false);
  });

  test('dotted-quad embedded IPv4 parses identically to its hex form (regression)', () => {
    // Regression: ::ffff:a.b.c.d used to be misplaced by the group parser.
    // The dotted and hex spellings must expand to the same 128-bit value.
    // In an IPv4-mapped address the v4 part occupies the LOW 32 bits
    // (after 96 bits of ::ffff prefix), so each additional 8 bits of prefix
    // pins one more IPv4 octet.
    expect(isIpInCidr('::ffff:10.0.0.5', '::ffff:10.0.0.0/104')).toBe(true);
    expect(isIpInCidr('::ffff:11.0.0.5', '::ffff:10.0.0.0/104')).toBe(false);
    expect(isIpInCidr('::ffff:10.1.0.5', '::ffff:10.0.0.0/112')).toBe(false);
    expect(isIpInCidr('::ffff:10.0.1.5', '::ffff:10.0.0.0/120')).toBe(false);
    expect(isIpInCidr('::ffff:10.0.0.6', '::ffff:10.0.0.5/128')).toBe(false);

    // Dotted vs hex vs full-form spellings agree in both directions.
    expect(isIpInCidr('::ffff:a00:5', '::ffff:10.0.0.5/128')).toBe(true);
    expect(isIpInCidr('::ffff:10.0.0.5', '::ffff:a00:5/128')).toBe(true);
    expect(isIpInCidr('::ffff:0a00:0005', '::ffff:10.0.0.5/128')).toBe(true);
    expect(isIpInCidr('::ffff:10.0.0.6', '::ffff:a00:5/128')).toBe(false);
  });

  test('rejects malformed inputs safely', () => {
    expect(isIpInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('10.0.0.1', 'not-a-cidr')).toBe(false);
    expect(isIpInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
  });
});

describe('isValidIp', () => {
  test('accepts valid IPv4, IPv6 and mapped forms', () => {
    expect(isValidIp('10.0.0.1')).toBe(true);
    expect(isValidIp('::1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp('::ffff:10.0.0.1')).toBe(true);
    expect(isValidIp('::ffff:a00:5')).toBe(true);
  });

  test('rejects garbage that could otherwise become a rate-limit key', () => {
    expect(isValidIp('not-an-ip')).toBe(false);
    expect(isValidIp('999.999.999.999')).toBe(false);
    expect(isValidIp('1.2.3')).toBe(false);
    expect(isValidIp('::gggg')).toBe(false);
    expect(isValidIp('a::b::c')).toBe(false);
    expect(isValidIp('')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  const trusted = ['127.0.0.1/32', '::1/128', '10.0.0.0/8'];

  test('returns unknown when the peer address is missing', () => {
    expect(resolveClientIp({ xff: '1.2.3.4', peerIp: undefined, trustedCidrs: trusted })).toBe(
      'unknown',
    );
    expect(resolveClientIp({})).toBe('unknown');
  });

  test('ignores XFF entirely when no trusted CIDRs are configured', () => {
    expect(resolveClientIp({ xff: '1.2.3.4, 5.6.7.8', peerIp: '203.0.113.9' })).toBe('203.0.113.9');
    expect(resolveClientIp({ xff: '1.2.3.4', peerIp: '203.0.113.9', trustedCidrs: [] })).toBe(
      '203.0.113.9',
    );
  });

  test('ignores XFF when the direct peer is not a trusted proxy', () => {
    // A public client connecting directly: whatever XFF it sends is spoofable.
    expect(
      resolveClientIp({ xff: '1.2.3.4', peerIp: '203.0.113.9', trustedCidrs: trusted }),
    ).toBe('203.0.113.9');
  });

  test('walks the XFF chain right-to-left past trusted proxies for a trusted peer', () => {
    // Client → proxy(10.0.0.9) → us; proxy appended client IP to XFF.
    expect(
      resolveClientIp({ xff: '198.51.100.7', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('198.51.100.7');
  });

  test('skips intermediate trusted proxies inside the chain', () => {
    // Chain: client(198.51.100.7) → outer proxy(10.0.0.9) → inner proxy(10.1.1.1) → us.
    // Right-to-left: 10.1.1.1 (trusted, skip), then 198.51.100.7 (not trusted) wins.
    expect(
      resolveClientIp({
        xff: '10.0.0.9, 198.51.100.7, 10.1.1.1',
        peerIp: '10.2.2.2',
        trustedCidrs: trusted,
      }),
    ).toBe('198.51.100.7');
  });

  test('falls back to the peer when every XFF hop is trusted', () => {
    expect(
      resolveClientIp({ xff: '10.0.0.9, 127.0.0.1', peerIp: '10.0.0.1', trustedCidrs: trusted }),
    ).toBe('10.0.0.1');
  });

  test('falls back to the peer when XFF is absent or unparsable', () => {
    expect(resolveClientIp({ peerIp: '10.0.0.9', trustedCidrs: trusted })).toBe('10.0.0.9');
    expect(resolveClientIp({ xff: ',', peerIp: '10.0.0.9', trustedCidrs: trusted })).toBe(
      '10.0.0.9',
    );
  });

  test('falls back to the peer when an XFF candidate is not a valid IP', () => {
    // A trusted proxy chain ending in garbage: the garbage entry would
    // otherwise be returned verbatim and let attackers rotate limit keys.
    expect(
      resolveClientIp({ xff: 'garbage!!', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('10.0.0.9');
    expect(
      resolveClientIp({ xff: '198.51.100.7, <script>', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('10.0.0.9');
    // Out-of-range octets are invalid too.
    expect(
      resolveClientIp({ xff: '999.1.1.1', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('10.0.0.9');
  });

  test('still returns a valid, non-trusted XFF candidate after validation', () => {
    expect(
      resolveClientIp({ xff: '198.51.100.7', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('198.51.100.7');
    expect(
      resolveClientIp({ xff: '2001:db8::7', peerIp: '10.0.0.9', trustedCidrs: trusted }),
    ).toBe('2001:db8::7');
  });

  test('handles IPv6 peers and IPv4-mapped normalization end-to-end', () => {
    // Loopback peer over IPv6 is trusted; mapped form normalizes into IPv4 CIDR.
    expect(resolveClientIp({ xff: '198.51.100.1', peerIp: '::1', trustedCidrs: trusted })).toBe(
      '198.51.100.1',
    );
    expect(
      resolveClientIp({ xff: '198.51.100.1', peerIp: '::ffff:127.0.0.1', trustedCidrs: trusted }),
    ).toBe('198.51.100.1');
    expect(
      resolveClientIp({ xff: '198.51.100.1', peerIp: '::ffff:203.0.113.5', trustedCidrs: trusted }),
    ).toBe('::ffff:203.0.113.5');
  });
});
