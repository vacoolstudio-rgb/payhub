import { Inject, Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { type AppConfig, appConfig } from '@payhub/config';
import type { AuthenticatedPrincipal } from '@payhub/shared';
import {
  PAYMENT_UPDATED_EVENT,
  type PaymentUpdatedEvent,
  WALLET_UPDATED_EVENT,
  type WalletUpdatedEvent,
} from '../modules/payment/application/payment.events.js';
import { TOKEN_ISSUER, type TokenIssuer } from '../modules/identity/application/token-issuer.port.js';
import { MerchantService } from '../modules/merchant/application/merchant.service.js';

interface AuthenticatedSocket extends Socket {
  data: { user?: AuthenticatedPrincipal };
}

/**
 * A socket frame is client input, exactly like a request body.
 *
 * The handler used to declare `payload: { merchantId: string }` and trust
 * it. Nothing enforced that: `{}` reached the authorisation check as
 * `undefined` and `null` crashed the handler on property access. The
 * annotation was a claim, not a guarantee — so make it one.
 *
 * Validated with Zod rather than a `ZodValidationPipe`: a pipe throws a
 * `ValidationError`, and Nest's WebSocket exception handler turns
 * anything that is not a `WsException` into "Internal server error",
 * which is the wrong answer to tell a client who sent a bad frame.
 */
const subscribeMerchantSchema = z.object({
  merchantId: z.string().uuid(),
});

/**
 * Live payment and balance updates.
 *
 * WebSocket and not SSE here because the channel is bidirectional (the
 * client subscribes and unsubscribes from merchant rooms) and carries many
 * small messages. SSE is used for the assistant stream, where the traffic is
 * one-directional and long-lived — different problem, different tool.
 *
 * Rooms do the authorisation work: a socket is joined to `user:<id>` at
 * connection time and can only ask to join a merchant room it owns, so
 * broadcasting is a single `to(room).emit` with no per-message filtering.
 */
@WebSocketGateway({
  namespace: '/realtime',
  // Socket.IO negotiates: start on polling, upgrade to WebSocket. Keeping
  // polling as a fallback is what makes this work behind proxies that still
  // mangle Upgrade headers.
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: true },
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    private readonly merchants: MerchantService,
    @Inject(appConfig.KEY) private readonly config: AppConfig,
  ) {}

  /**
   * Authentication happens at the handshake, not per message.
   *
   * The browser WebSocket API cannot set headers, so the token arrives in
   * `auth` (Socket.IO's handshake payload) rather than `Authorization` —
   * and never in the query string, which ends up in proxy access logs.
   */
  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const token =
        (client.handshake.auth as { token?: string } | undefined)?.token ??
        client.handshake.headers.authorization?.replace(/^Bearer /i, '');

      if (!token) {
        throw new WsException('Missing access token');
      }

      const claims = await this.tokens.verifyAccessToken(token);

      client.data.user = {
        id: claims.sub,
        kind: 'user',
        email: claims.email,
        roles: claims.roles,
        permissions: claims.permissions,
        sessionId: claims.jti,
      };

      await client.join(`user:${claims.sub}`);

      client.emit('connected', { userId: claims.sub, serverTime: new Date().toISOString() });
      this.logger.debug(`Socket ${client.id} connected as ${claims.sub}`);
    } catch (error) {
      this.logger.debug(
        `Rejecting socket ${client.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.emit('unauthorized', { message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  @SubscribeMessage('subscribe:merchant')
  async subscribeToMerchant(
    client: AuthenticatedSocket,
    payload: unknown,
  ): Promise<{ subscribed: string }> {
    const user = client.data.user;

    if (!user) {
      throw new WsException('Not authenticated');
    }

    const parsed = subscribeMerchantSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WsException('subscribe:merchant requires a merchantId (uuid)');
    }
    const { merchantId } = parsed.data;

    // Never decided by the message — otherwise any client could subscribe
    // to anyone's traffic.
    //
    // It used to be decided by `user.merchantId`, a claim only an API-key
    // principal carries. A user's access token has no such claim, so the
    // comparison was `undefined !== merchantId` for every human client:
    // always true, always refused, and silently, because the only account
    // anyone tested with was also an admin and took the bypass.
    //
    // Ownership is a fact about the merchant, so it is read from the
    // merchant context — the same question the refund path asks.
    const allowed =
      user.permissions.includes('admin:*') ||
      user.merchantId === merchantId ||
      (user.kind === 'user' && (await this.merchants.mayActFor(merchantId, user.id)));

    if (!allowed) {
      throw new WsException('Not allowed to subscribe to this merchant');
    }

    await client.join(`merchant:${merchantId}`);
    return { subscribed: `merchant:${merchantId}` };
  }

  @SubscribeMessage('ping')
  handlePing(): { pong: number } {
    return { pong: Date.now() };
  }

  /**
   * Bridges the in-process event bus to the sockets.
   *
   * With the Redis adapter installed, `server.to(room).emit` reaches sockets
   * connected to *other* replicas too — which is the whole reason the
   * adapter exists. Without it, a user connected to pod B would never see an
   * event produced on pod A.
   */
  @OnEvent(PAYMENT_UPDATED_EVENT)
  broadcastPayment(event: PaymentUpdatedEvent): void {
    this.server.to(`user:${event.userId}`).emit('payment:updated', event.payment);
    this.server.to(`merchant:${event.merchantId}`).emit('payment:updated', event.payment);
  }

  @OnEvent(WALLET_UPDATED_EVENT)
  broadcastWallet(event: WalletUpdatedEvent): void {
    this.server.to(`user:${event.userId}`).emit('wallet:updated', {
      walletId: event.walletId,
      available: event.available,
      pending: event.pending,
    });
  }

  /** Used by the health endpoint to report connection pressure. */
  async connectedSockets(): Promise<number> {
    const sockets = await this.server.fetchSockets();
    return sockets.length;
  }

  get namespace(): string {
    return `/realtime (${this.config.serviceName})`;
  }
}
