import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AuthConfig, authConfig } from '@payhub/config';
import { ForbiddenError, NotFoundError } from '@payhub/kernel';
import { TransactionManager, Transactional } from '@payhub/persistence';
import { generateApiKey, hashApiKey } from '@payhub/shared';
import { ApiKey, ApiKeyId, type ApiScope } from '../domain/api-key.aggregate.js';
import { API_KEY_REPOSITORY, type ApiKeyRepository } from '../domain/identity.ports.js';
import { ResourceVersionService } from '@payhub/redis';
import { ApiKeyAuthenticator } from './api-key-authenticator.service.js';
import { IdentityScopes } from './identity.cache-scopes.js';

export interface CreateApiKeyCommand {
  readonly merchantId: string;
  readonly name: string;
  readonly scopes: ApiScope[];
  readonly environment: 'live' | 'test';
  readonly expiresAt?: Date | null;
}

export interface CreatedApiKey {
  readonly id: string;
  /** Shown exactly once. We only store a hash, so it cannot be recovered. */
  readonly plaintext: string;
  readonly maskedKey: string;
  readonly scopes: readonly string[];
  readonly environment: string;
  readonly expiresAt: string | null;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    private readonly authenticator: ApiKeyAuthenticator,
    private readonly transactions: TransactionManager,
    private readonly versions: ResourceVersionService,
  ) {}

  @Transactional()
  async create(command: CreateApiKeyCommand): Promise<CreatedApiKey> {
    const { plaintext, prefix, last4 } = generateApiKey(command.environment);

    const key = ApiKey.issue({
      id: ApiKeyId.create(),
      merchantId: command.merchantId,
      name: command.name,
      keyHash: hashApiKey(plaintext, this.config.apiKeyPepper),
      prefix,
      last4,
      environment: command.environment,
      scopes: command.scopes,
      expiresAt: command.expiresAt ?? null,
    });

    await this.keys.insert(key);
    this.transactions.afterCommit(() =>
      this.versions.bump(IdentityScopes.apiKeysOf(command.merchantId)),
    );
    this.logger.log(`Issued ${command.environment} API key ${key.id} for merchant ${command.merchantId}`);

    return {
      id: key.id,
      plaintext,
      maskedKey: `${prefix}…${last4}`,
      scopes: key.scopes,
      environment: key.environment,
      expiresAt: key.expiresAt?.toISOString() ?? null,
    };
  }

  async list(merchantId: string): Promise<Array<Record<string, unknown>>> {
    const keys = await this.keys.listByMerchant(merchantId);
    return keys.map((key) => key.toPublicJSON());
  }

  @Transactional()
  async revoke(merchantId: string, keyId: string): Promise<void> {
    const key = await this.keys.findById(ApiKeyId.of(keyId));

    if (!key) {
      throw new NotFoundError('ApiKey', keyId);
    }
    if (key.merchantId !== merchantId) {
      // Deliberately a 403 rather than a 404: the caller proved they are a
      // merchant, just not this one.
      throw new ForbiddenError('This key belongs to another merchant', 'API_KEY_FOREIGN');
    }

    key.revoke();
    await this.keys.save(key);

    // After the commit, never inside it. Dropping the entry while the row
    // is still uncommitted lets a concurrent request miss, read the
    // not-yet-revoked row and cache it again — the key would then keep
    // working for a full TTL after a revocation that appeared to succeed.
    this.transactions.afterCommit(async () => {
      await this.authenticator.invalidate(key.keyHash);
      await this.versions.bump(IdentityScopes.apiKeysOf(merchantId));
    });
  }
}
