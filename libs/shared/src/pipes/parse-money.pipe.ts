import { Injectable, type PipeTransform } from '@nestjs/common';
import { Money, ValidationError } from '@payhub/kernel';

export interface MoneyInput {
  amount: string;
  currency: string;
}

/** Turns the wire representation of money into the domain value object. */
@Injectable()
export class ParseMoneyPipe implements PipeTransform<MoneyInput, Money> {
  transform(value: MoneyInput): Money {
    if (!value || typeof value.amount !== 'string' || typeof value.currency !== 'string') {
      throw new ValidationError('Expected { amount, currency }', { value }, 'INVALID_AMOUNT');
    }

    const money = Money.parseMajor(value.amount, value.currency);
    if (money.isErr()) {
      throw money.error;
    }
    return money.value;
  }
}
