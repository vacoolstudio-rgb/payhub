import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO Redis adapter.
 *
 * Socket.IO keeps its room membership in process memory. Behind two
 * replicas, `server.to('user:42').emit(...)` from pod A silently does
 * nothing for a client connected to pod B — the single most common "works
 * locally, broken in production" bug with WebSockets.
 *
 * The adapter publishes every emit over Redis pub/sub so all replicas
 * deliver it. It needs **two dedicated connections**: a Redis client in
 * subscriber mode cannot issue ordinary commands, so the publisher cannot be
 * reused as the subscriber.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
    private readonly keyPrefix: string,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    const pubClient = new Redis(this.redisUrl, { lazyConnect: true });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.clients = [pubClient, subClient];

    this.adapterConstructor = createAdapter(pubClient, subClient, {
      key: `${this.keyPrefix}:socket.io`,
    });

    this.log.log('Socket.IO Redis adapter connected');
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      // 1 MiB is already generous for UI events; anything larger is either
      // a bug or an attempt to exhaust memory.
      maxHttpBufferSize: 1e6,
    } as ServerOptions) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    return server;
  }

  override async close(server: unknown): Promise<void> {
    await super.close(server as never);
    await Promise.allSettled(this.clients.map((client) => client.quit()));
  }
}
