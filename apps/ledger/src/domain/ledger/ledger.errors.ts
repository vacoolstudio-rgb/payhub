import { ConflictError, DomainError, ErrorKind, InvalidStateError, ValidationError } from '@payhub/kernel';
import type { Money } from '@payhub/kernel';

export class UnbalancedEntryError extends ValidationError {
  constructor(currency: string, debits: string, credits: string) {
    super(
      `Journal entry does not balance in ${currency}: debits ${debits} ≠ credits ${credits}`,
      { currency, debits, credits },
      'UNBALANCED_ENTRY',
    );
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  readonly kind = ErrorKind.PreconditionFailed;

  constructor(walletId: string, available: Money, requested: Money) {
    super(
      `Wallet balance ${available.toString()} is below the requested ${requested.toString()}`,
      {
        walletId,
        available: available.toJSON(),
        requested: requested.toJSON(),
        shortfall: requested.subtract(available).toJSON(),
      },
    );
  }
}

export class WalletFrozenError extends InvalidStateError {
  constructor(walletId: string) {
    super('Wallet is frozen and cannot move money', 'WALLET_FROZEN', { walletId });
  }
}

export class WalletClosedError extends InvalidStateError {
  constructor(walletId: string) {
    super('Wallet is closed', 'WALLET_CLOSED', { walletId });
  }
}

export class EntryAlreadyReversedError extends ConflictError {
  constructor(entryId: string) {
    super('Journal entry has already been reversed', 'ENTRY_ALREADY_REVERSED', { entryId });
  }
}

export class DuplicateTransferError extends ConflictError {
  constructor(transferId: string) {
    super('A transfer with this id was already posted', 'DUPLICATE_TRANSFER', { transferId });
  }
}
