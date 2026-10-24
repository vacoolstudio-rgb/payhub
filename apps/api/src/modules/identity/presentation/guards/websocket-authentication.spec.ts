import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthenticationGuard } from './authentication.guard.js';

const CLAIMS = {
  sub: 'user-1',
  jti: 'session-1',
  email: 'ada@payhub.dev',
  roles: ['user'],
  permissions: ['payment:read'],
  iat: 1,
};

function wsContext(handshake: unknown): ExecutionContext {
  return {
    getType: () => 'ws',
    getHandler: () => function handler() {},
    getClass: () => class Gateway {},
    switchToWs: () => ({ getClient: () => ({ handshake }) }),
  } as unknown as ExecutionContext;
}

/**
 * A socket message has to authenticate like everything else.
 *
 * The browser WebSocket API cannot set headers, so socket.io carries the
 * token in the handshake's `auth` payload. The guard read only headers,
 * so every message from a browser client was rejected as
 * unauthenticated — and the gateway's whole `subscribe:merchant` feature
 * was unreachable without anyone noticing, because the guard's websocket
 * branch *looked* complete: it built a `user` field from the socket that
 * nothing downstream ever read.
 */
describe('AuthenticationGuard over websockets', () => {
  let guard: AuthenticationGuard;
  let verifyAccessToken: ReturnType<typeof vi.fn>;
  let isRevoked: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    verifyAccessToken = vi.fn().mockResolvedValue(CLAIMS);
    isRevoked = vi.fn().mockResolvedValue(false);

    guard = new AuthenticationGuard(
      { getAllAndOverride: () => false } as never,
      { verifyAccessToken } as never,
      {} as never,
      {} as never,
      { isRevoked } as never,
      {} as never,
      { isActive: () => false, set: vi.fn() } as never,
      {} as never,
    );
  });

  it('accepts a token presented in the handshake auth payload', async () => {
    const context = wsContext({ headers: {}, auth: { token: 'jwt-value' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyAccessToken).toHaveBeenCalledWith('jwt-value');
  });

  /**
   * The point of going through the normal path rather than trusting the
   * principal the gateway attached at connection time: a session revoked
   * while the socket is open stops being able to act on the next message,
   * instead of staying live until the client reconnects.
   */
  it('refuses a message on a socket whose session was revoked', async () => {
    isRevoked.mockResolvedValue(true);
    const context = wsContext({ headers: {}, auth: { token: 'jwt-value' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('still accepts an authorization header when a client can set one', async () => {
    const context = wsContext({ headers: { authorization: 'Bearer header-value' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyAccessToken).toHaveBeenCalledWith('header-value');
  });

  it('prefers the header over the handshake when both are present', async () => {
    const context = wsContext({
      headers: { authorization: 'Bearer header-value' },
      auth: { token: 'handshake-value' },
    });

    await guard.canActivate(context);

    expect(verifyAccessToken).toHaveBeenCalledWith('header-value');
  });

  it('refuses a socket that presented nothing', async () => {
    await expect(guard.canActivate(wsContext({ headers: {} }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
