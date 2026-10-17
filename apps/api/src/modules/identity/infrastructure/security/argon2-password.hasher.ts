import { Inject, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { type AuthConfig, authConfig } from '@payhub/config';
import type { PasswordHasher } from '../../domain/identity.ports.js';

/**
 * argon2id password hashing.
 *
 * argon2id (not bcrypt, not argon2i) because it is the OWASP default: the
 * hybrid mode resists both GPU cracking and side-channel attacks. The
 * parameters below are the OWASP minimum — 19 MiB of memory per hash, which
 * is what makes a hash expensive for an attacker with a rack of GPUs and
 * cheap for a server doing a handful of logins per second.
 *
 * Memory cost, not time cost, is the lever that hurts GPUs: they have plenty
 * of cores and very little memory per core.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  constructor(@Inject(authConfig.KEY) private readonly config: AuthConfig) {}

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, {
      // `Algorithm.Argon2id` is an ambient const enum, which isolatedModules
      // cannot inline; 2 is its documented value.
      algorithm: 2,
      memoryCost: this.config.argon2.memoryCost,
      timeCost: this.config.argon2.timeCost,
      parallelism: this.config.argon2.parallelism,
    });
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext);
    } catch {
      // A malformed hash in the database must read as "wrong password",
      // never as a 500 that tells an attacker something interesting.
      return false;
    }
  }

  /**
   * Detects hashes produced with weaker parameters than the current policy,
   * so they can be upgraded silently on the next successful login.
   */
  needsRehash(storedHash: string): boolean {
    const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!match) {
      return true;
    }

    const [, memory, time, parallelism] = match;

    return (
      Number(memory) < this.config.argon2.memoryCost ||
      Number(time) < this.config.argon2.timeCost ||
      Number(parallelism) < this.config.argon2.parallelism
    );
  }
}
