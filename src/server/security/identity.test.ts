import { describe, expect, it } from 'vitest';
import { createSessionIdentity, readOwnerCookie, ownerCookieHeader } from './identity.js';

describe('createSessionIdentity', () => {
  it('issue returns a token and 32-char hex ownerId', () => {
    const identity = createSessionIdentity();
    const { token, ownerId } = identity.issue();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(ownerId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('roundtrip: issued token verifies to the same ownerId', () => {
    const identity = createSessionIdentity();
    const { token, ownerId } = identity.issue();
    expect(identity.verify(token)).toBe(ownerId);
  });

  it('each issue produces a different ownerId', () => {
    const identity = createSessionIdentity();
    const a = identity.issue();
    const b = identity.issue();
    expect(a.ownerId).not.toBe(b.ownerId);
    expect(a.token).not.toBe(b.token);
  });

  it('rejects expired token', () => {
    let time = 10000;
    const identity = createSessionIdentity({ ttlMs: 500, now: () => time });
    const { token } = identity.issue();
    time = 10600;
    expect(identity.verify(token)).toBeNull();
  });

  it('rejects token at exact expiry boundary', () => {
    let time = 10000;
    const identity = createSessionIdentity({ ttlMs: 500, now: () => time });
    const { token } = identity.issue();
    time = 10500;
    expect(identity.verify(token)).toBeNull();
  });

  it('accepts token just before expiry', () => {
    let time = 10000;
    const identity = createSessionIdentity({ ttlMs: 500, now: () => time });
    const { token, ownerId } = identity.issue();
    time = 10499;
    expect(identity.verify(token)).toBe(ownerId);
  });

  it('rejects forged signature', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[2] = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects token with tampered ownerId', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[0] = '00000000000000000000000000000000';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects token with tampered expiry', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[1] = String(Number(parts[1]) + 1);
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects future token (expiry beyond TTL window)', () => {
    const secret = new Uint8Array(32).fill(42);
    let time = 10000;
    const short = createSessionIdentity({ secret, ttlMs: 1000, now: () => time });
    const long = createSessionIdentity({ secret, ttlMs: 100000, now: () => time });
    const { token } = long.issue();
    expect(short.verify(token)).toBeNull();
  });

  it('rejects undefined token', () => {
    const identity = createSessionIdentity();
    expect(identity.verify(undefined)).toBeNull();
  });

  it('rejects empty string', () => {
    const identity = createSessionIdentity();
    expect(identity.verify('')).toBeNull();
  });

  it('rejects token with wrong number of parts', () => {
    const identity = createSessionIdentity();
    expect(identity.verify('a.b')).toBeNull();
    expect(identity.verify('a.b.c.d')).toBeNull();
    expect(identity.verify('onlyonepart')).toBeNull();
  });

  it('rejects non-hex ownerId', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[0] = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects ownerId of wrong length', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[0] = 'abcdef';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects non-numeric expiry', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[1] = 'notanumber';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects negative expiry', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[1] = '-1';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('rejects Infinity expiry', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[1] = 'Infinity';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });

  it('tokens from different secrets do not verify', () => {
    const id1 = createSessionIdentity({ secret: new Uint8Array(32).fill(1) });
    const id2 = createSessionIdentity({ secret: new Uint8Array(32).fill(2) });
    const { token } = id1.issue();
    expect(id2.verify(token)).toBeNull();
  });

  it('uses provided test secret deterministically', () => {
    const secret = new Uint8Array(32).fill(99);
    let time = 5000;
    const id1 = createSessionIdentity({ secret, ttlMs: 10000, now: () => time });
    const id2 = createSessionIdentity({ secret, ttlMs: 10000, now: () => time });
    const { token } = id1.issue();
    expect(id2.verify(token)).toBeTruthy();
  });

  it('rejects signature with wrong length', () => {
    const identity = createSessionIdentity();
    const { token } = identity.issue();
    const parts = token.split('.');
    parts[2] = 'short';
    expect(identity.verify(parts.join('.'))).toBeNull();
  });
});

describe('readOwnerCookie', () => {
  it('extracts wave_owner from a simple header', () => {
    expect(readOwnerCookie('wave_owner=abc123')).toBe('abc123');
  });

  it('extracts wave_owner from multiple cookies', () => {
    expect(readOwnerCookie('session=xyz; wave_owner=token456; theme=dark')).toBe('token456');
  });

  it('returns undefined for missing cookie', () => {
    expect(readOwnerCookie('session=xyz; theme=dark')).toBeUndefined();
  });

  it('returns undefined for undefined header', () => {
    expect(readOwnerCookie(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string header', () => {
    expect(readOwnerCookie('')).toBeUndefined();
  });

  it('returns undefined for empty cookie value', () => {
    expect(readOwnerCookie('wave_owner=')).toBeUndefined();
  });

  it('handles tokens containing dots and base64url characters', () => {
    const token = 'abc123.456.sig_value-here';
    expect(readOwnerCookie(`wave_owner=${token}`)).toBe(token);
  });

  it('handles whitespace around cookie values', () => {
    expect(readOwnerCookie('  wave_owner = tok  ; other=x')).toBe('tok');
  });

  it('does not match partial cookie names', () => {
    expect(readOwnerCookie('not_wave_owner=abc')).toBeUndefined();
    expect(readOwnerCookie('wave_owner_extra=abc')).toBeUndefined();
  });
});

describe('ownerCookieHeader', () => {
  it('sets cookie name and value', () => {
    const header = ownerCookieHeader('mytoken');
    expect(header).toContain('wave_owner=mytoken');
  });

  it('sets HttpOnly', () => {
    expect(ownerCookieHeader('t')).toContain('HttpOnly');
  });

  it('sets SameSite=Strict', () => {
    expect(ownerCookieHeader('t')).toContain('SameSite=Strict');
  });

  it('sets Path=/', () => {
    expect(ownerCookieHeader('t')).toContain('Path=/');
  });

  it('omits Secure by default', () => {
    expect(ownerCookieHeader('t')).not.toContain('Secure');
  });

  it('includes Secure when requested', () => {
    expect(ownerCookieHeader('t', true)).toContain('Secure');
  });

  it('omits Secure when explicitly false', () => {
    expect(ownerCookieHeader('t', false)).not.toContain('Secure');
  });

  it('roundtrips: readOwnerCookie parses ownerCookieHeader token', () => {
    const token = 'abc.123.sig';
    const setCookie = ownerCookieHeader(token, true);
    const cookieValue = setCookie.split(';')[0];
    expect(readOwnerCookie(cookieValue)).toBe(token);
  });
});
