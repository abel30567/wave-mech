export interface ToolAccessOptions {
  fermiUrl: string;
  nodeExecutable: string;
  hookFile: string;
}

export interface IdentityOptions {
  secret?: Uint8Array;
  ttlMs?: number;
  now?: () => number;
}

export interface SessionIdentity {
  issue(): { token: string; ownerId: string };
  verify(token: string | undefined): string | null;
}
