import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { IdentityOptions, SessionIdentity } from '../../shared/access-contracts.js';

const DEFAULT_TTL_MS = 86_400_000;
const OWNER_ID_BYTES = 16;
const SECRET_BYTES = 32;
const COOKIE_NAME = 'wave_owner';

export function createSessionIdentity(options?: IdentityOptions): SessionIdentity {
  const secret = options?.secret ?? randomBytes(SECRET_BYTES);
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = options?.now ?? (() => Date.now());

  function sign(payload: string): Buffer {
    return createHmac('sha256', secret).update(payload).digest();
  }

  return {
    issue() {
      const ownerId = randomBytes(OWNER_ID_BYTES).toString('hex');
      const expiresAt = now() + ttlMs;
      const payload = `${ownerId}.${expiresAt}`;
      const sig = sign(payload).toString('base64url');
      return { token: `${payload}.${sig}`, ownerId };
    },

    verify(token: string | undefined): string | null {
      if (!token || typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [ownerId, expiresAtStr, providedSig] = parts;
      if (!/^[0-9a-f]{32}$/.test(ownerId)) return null;

      const expiresAt = Number(expiresAtStr);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

      const currentTime = now();
      if (currentTime >= expiresAt) return null;
      if (expiresAt > currentTime + ttlMs) return null;

      const payload = `${ownerId}.${expiresAtStr}`;
      const expected = sign(payload);
      const provided = Buffer.from(providedSig, 'base64url');
      if (expected.length !== provided.length) return null;
      if (!timingSafeEqual(expected, provided)) return null;

      return ownerId;
    },
  };
}

export function readOwnerCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

export function ownerCookieHeader(token: string, secure?: boolean): string {
  let value = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  if (secure) value += '; Secure';
  return value;
}
