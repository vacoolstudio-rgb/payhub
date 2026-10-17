import { Injectable } from '@nestjs/common';
import { ConcurrencyError } from '@payhub/kernel';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import { IsNull, LessThan } from 'typeorm';
import { ApiKey, ApiKeyId, type ApiScope } from '../../../domain/api-key.aggregate.js';
import { Email } from '../../../domain/email.vo.js';
import type {
  ApiKeyRepository,
  RefreshSessionRepository,
  UserRepository,
} from '../../../domain/identity.ports.js';
import {
  RefreshSession,
  SessionId,
  TokenFamilyId,
} from '../../../domain/refresh-session.aggregate.js';
import { User, UserId, type UserStatus } from '../../../domain/user.aggregate.js';
import type { Role } from '../../../domain/role.vo.js';
import { ApiKeyEntity } from '../entities/api-key.entity.js';
import { RefreshSessionEntity } from '../entities/refresh-session.entity.js';
import { UserEntity } from '../entities/user.entity.js';

@Injectable()
export class TypeOrmUserRepository
  extends TypeOrmRepositoryBase<UserEntity>
  implements UserRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, UserEntity);
  }

  async findById(id: UserId): Promise<User | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? toUser(entity) : null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    const entity = await this.repository.findOne({ where: { email: email.value } });
    return entity ? toUser(entity) : null;
  }

  async existsByEmail(email: Email): Promise<boolean> {
    return this.repository.exists({ where: { email: email.value } });
  }

  async insert(user: User): Promise<void> {
    await this.repository.insert({
      id: user.id,
      email: user.email.value,
      passwordHash: user.passwordHash,
      displayName: user.displayName,
      roles: [...user.roles],
      status: user.status,
      emailVerified: user.emailVerified,
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
      lastLoginAt: user.lastLoginAt,
      tokensValidFrom: user.tokensValidFrom,
    });
  }

  async save(user: User): Promise<void> {
    const result = await this.repository
      .createQueryBuilder()
      .update(UserEntity)
      .set({
        passwordHash: user.passwordHash,
        displayName: user.displayName,
        roles: [...user.roles],
        status: user.status,
        emailVerified: user.emailVerified,
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        lastLoginAt: user.lastLoginAt,
        tokensValidFrom: user.tokensValidFrom,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where('id = :id AND version = :version', { id: user.id, version: user.version })
      .execute();

    if (result.affected === 0) {
      throw new ConcurrencyError('User', user.id, user.version);
    }
    user.setVersion(user.version + 1);
  }
}

@Injectable()
export class TypeOrmRefreshSessionRepository
  extends TypeOrmRepositoryBase<RefreshSessionEntity>
  implements RefreshSessionRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, RefreshSessionEntity);
  }

  async findByTokenHash(hash: string): Promise<RefreshSession | null> {
    const entity = await this.repository.findOne({ where: { tokenHash: hash } });
    return entity ? toSession(entity) : null;
  }

  async findById(id: SessionId): Promise<RefreshSession | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? toSession(entity) : null;
  }

  async insert(session: RefreshSession): Promise<void> {
    await this.repository.insert({
      id: session.id,
      userId: session.userId,
      familyId: session.familyId,
      tokenHash: session.tokenHash,
      usedAt: session.usedAt,
      revokedAt: session.revokedAt,
      replacedBy: session.replacedBy,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
      ip: session.ip,
    });
  }

  async save(session: RefreshSession): Promise<void> {
    await this.repository.update(
      { id: session.id },
      {
        usedAt: session.usedAt,
        revokedAt: session.revokedAt,
        replacedBy: session.replacedBy,
      },
    );
  }

  /** One statement, so a reuse response cannot be partially applied. */
  async revokeFamily(familyId: TokenFamilyId, now: Date): Promise<number> {
    const result = await this.repository.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: now },
    );
    return result.affected ?? 0;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    const result = await this.repository.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: now },
    );
    return result.affected ?? 0;
  }

  async purgeExpired(before: Date): Promise<number> {
    const result = await this.repository.delete({ expiresAt: LessThan(before) });
    return result.affected ?? 0;
  }
}

@Injectable()
export class TypeOrmApiKeyRepository
  extends TypeOrmRepositoryBase<ApiKeyEntity>
  implements ApiKeyRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, ApiKeyEntity);
  }

  async findByHash(hash: string): Promise<ApiKey | null> {
    const entity = await this.repository.findOne({ where: { keyHash: hash } });
    return entity ? toApiKey(entity) : null;
  }

  async findById(id: ApiKeyId): Promise<ApiKey | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? toApiKey(entity) : null;
  }

  async listByMerchant(merchantId: string): Promise<ApiKey[]> {
    const entities = await this.repository.find({
      where: { merchantId },
      order: { createdAt: 'DESC' },
    });
    return entities.map((entity) => toApiKey(entity));
  }

  async insert(key: ApiKey): Promise<void> {
    await this.repository.insert({
      id: key.id,
      merchantId: key.merchantId,
      name: key.name,
      keyHash: key.keyHash,
      prefix: key.prefix,
      last4: key.last4,
      environment: key.environment,
      scopes: [...key.scopes],
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
      expiresAt: key.expiresAt,
    });
  }

  async save(key: ApiKey): Promise<void> {
    await this.repository.update(
      { id: key.id },
      {
        name: key.name,
        scopes: [...key.scopes],
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      },
    );
  }

  async touchLastUsed(id: ApiKeyId, now: Date): Promise<void> {
    await this.repository.update({ id }, { lastUsedAt: now });
  }
}

// --- mappers --------------------------------------------------------------

function toUser(entity: UserEntity): User {
  return User.rehydrate(
    UserId.of(entity.id),
    {
      email: Email.of(entity.email),
      passwordHash: entity.passwordHash,
      displayName: entity.displayName,
      roles: entity.roles as Role[],
      status: entity.status as UserStatus,
      emailVerified: entity.emailVerified,
      failedLoginAttempts: entity.failedLoginAttempts,
      lockedUntil: entity.lockedUntil,
      lastLoginAt: entity.lastLoginAt,
      tokensValidFrom: entity.tokensValidFrom,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    },
    entity.version,
  );
}

function toSession(entity: RefreshSessionEntity): RefreshSession {
  return RefreshSession.rehydrate(SessionId.of(entity.id), {
    userId: entity.userId,
    familyId: TokenFamilyId.of(entity.familyId),
    tokenHash: entity.tokenHash,
    usedAt: entity.usedAt,
    revokedAt: entity.revokedAt,
    replacedBy: entity.replacedBy ? SessionId.of(entity.replacedBy) : null,
    expiresAt: entity.expiresAt,
    userAgent: entity.userAgent,
    ip: entity.ip,
    createdAt: entity.createdAt,
  });
}

function toApiKey(entity: ApiKeyEntity): ApiKey {
  return ApiKey.rehydrate(ApiKeyId.of(entity.id), {
    merchantId: entity.merchantId,
    name: entity.name,
    keyHash: entity.keyHash,
    prefix: entity.prefix,
    last4: entity.last4,
    environment: entity.environment as 'live' | 'test',
    scopes: entity.scopes as ApiScope[],
    lastUsedAt: entity.lastUsedAt,
    revokedAt: entity.revokedAt,
    expiresAt: entity.expiresAt,
    createdAt: entity.createdAt,
  });
}
