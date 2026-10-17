import {
  AggregateRoot,
  type Brand,
  ForbiddenError,
  type Result,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';

export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export const ApiKeyId = uuidBrand<ApiKeyId>('ApiKeyId');

export const ApiScope = {
  PaymentsRead: 'payments:read',
  PaymentsWrite: 'payments:write',
  RefundsWrite: 'refunds:write',
  WalletsRead: 'wallets:read',
  WebhooksManage: 'webhooks:manage',
} as const;

export type ApiScope = (typeof ApiScope)[keyof typeof ApiScope];

interface ApiKeyProps {
  readonly merchantId: string;
  readonly name: string;
  /** HMAC-SHA256(key, pepper). Fast by design — see the note below. */
  readonly keyHash: string;
  readonly prefix: string;
  readonly last4: string;
  readonly environment: 'live' | 'test';
  scopes: ApiScope[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Merchant API key.
 *
 * Unlike a user password, an API key is a 256-bit random secret, so it has no
 * guessable structure and does not need a slow KDF: an HMAC with a
 * server-side pepper is both sufficient and fast enough to run on every
 * request. Running argon2 per request would turn the auth check into the
 * slowest part of the API. The pepper lives in configuration, so a leaked
 * database dump alone does not let an attacker verify keys offline.
 */
export class ApiKey extends AggregateRoot<ApiKeyId> {
  private constructor(
    id: ApiKeyId,
    private readonly props: ApiKeyProps,
  ) {
    super(id);
  }

  static issue(input: {
    id: ApiKeyId;
    merchantId: string;
    name: string;
    keyHash: string;
    prefix: string;
    last4: string;
    environment: 'live' | 'test';
    scopes: ApiScope[];
    expiresAt?: Date | null;
    now?: Date;
  }): ApiKey {
    return new ApiKey(input.id, {
      merchantId: input.merchantId,
      name: input.name,
      keyHash: input.keyHash,
      prefix: input.prefix,
      last4: input.last4,
      environment: input.environment,
      scopes: input.scopes,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: input.now ?? new Date(),
    });
  }

  static rehydrate(id: ApiKeyId, props: ApiKeyProps): ApiKey {
    return new ApiKey(id, props);
  }

  assertUsable(now = new Date()): Result<void, ForbiddenError> {
    if (this.props.revokedAt) {
      return err(new ForbiddenError('API key has been revoked', 'API_KEY_REVOKED'));
    }
    if (this.props.expiresAt && this.props.expiresAt <= now) {
      return err(new ForbiddenError('API key has expired', 'API_KEY_EXPIRED'));
    }
    return ok(undefined);
  }

  hasScopes(required: readonly string[]): boolean {
    return required.every((scope) => this.props.scopes.includes(scope as ApiScope));
  }

  touchUsage(now = new Date()): void {
    this.props.lastUsedAt = now;
  }

  revoke(now = new Date()): void {
    this.props.revokedAt ??= now;
  }

  get merchantId(): string {
    return this.props.merchantId;
  }

  get name(): string {
    return this.props.name;
  }

  get keyHash(): string {
    return this.props.keyHash;
  }

  get prefix(): string {
    return this.props.prefix;
  }

  get last4(): string {
    return this.props.last4;
  }

  get environment(): 'live' | 'test' {
    return this.props.environment;
  }

  get scopes(): readonly ApiScope[] {
    return this.props.scopes;
  }

  get lastUsedAt(): Date | null {
    return this.props.lastUsedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Never serialise the hash. */
  toPublicJSON(): Record<string, unknown> {
    return {
      id: this.id,
      merchantId: this.props.merchantId,
      name: this.props.name,
      maskedKey: `${this.props.prefix}…${this.props.last4}`,
      environment: this.props.environment,
      scopes: this.props.scopes,
      lastUsedAt: this.props.lastUsedAt?.toISOString() ?? null,
      revokedAt: this.props.revokedAt?.toISOString() ?? null,
      expiresAt: this.props.expiresAt?.toISOString() ?? null,
      createdAt: this.props.createdAt.toISOString(),
    };
  }
}
