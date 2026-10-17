import type { Email } from './email.vo.js';
import type { ApiKey, ApiKeyId } from './api-key.aggregate.js';
import type { RefreshSession, SessionId, TokenFamilyId } from './refresh-session.aggregate.js';
import type { User, UserId } from './user.aggregate.js';

export const USER_REPOSITORY = Symbol.for('payhub:UserRepository');
export const SESSION_REPOSITORY = Symbol.for('payhub:RefreshSessionRepository');
export const API_KEY_REPOSITORY = Symbol.for('payhub:ApiKeyRepository');
export const PASSWORD_HASHER = Symbol.for('payhub:PasswordHasher');

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  existsByEmail(email: Email): Promise<boolean>;
  save(user: User): Promise<void>;
  insert(user: User): Promise<void>;
}

export interface RefreshSessionRepository {
  findByTokenHash(hash: string): Promise<RefreshSession | null>;
  findById(id: SessionId): Promise<RefreshSession | null>;
  insert(session: RefreshSession): Promise<void>;
  save(session: RefreshSession): Promise<void>;
  /** Reuse detection: nuke every token descended from the same login. */
  revokeFamily(familyId: TokenFamilyId, now: Date): Promise<number>;
  revokeAllForUser(userId: string, now: Date): Promise<number>;
  purgeExpired(before: Date): Promise<number>;
}

export interface ApiKeyRepository {
  findByHash(hash: string): Promise<ApiKey | null>;
  findById(id: ApiKeyId): Promise<ApiKey | null>;
  listByMerchant(merchantId: string): Promise<ApiKey[]>;
  insert(key: ApiKey): Promise<void>;
  save(key: ApiKey): Promise<void>;
  /**
   * Records usage with a single UPDATE.
   *
   * Loading the aggregate to set one timestamp costs a SELECT and an
   * UPDATE on every authenticated request — pure write amplification for a
   * field nothing reads synchronously.
   */
  touchLastUsed(id: ApiKeyId, now: Date): Promise<void>;
}

/**
 * Password hashing as a port.
 *
 * The domain says "verify this password"; it does not know that the answer
 * involves argon2id with a 19 MiB memory cost. Swapping the algorithm — or
 * stubbing it with a no-op in tests, where argon2 would add seconds per
 * case — is then a one-line provider change.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
  /** True when the stored hash uses outdated parameters and should be re-hashed. */
  needsRehash(hash: string): boolean;
}
