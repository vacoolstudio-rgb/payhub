import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { PaymentDirection, PaymentStatus } from '../../modules/payment/domain/payment.aggregate.js';

/**
 * GraphQL enums, derived from the domain constants.
 *
 * `registerEnumType` names each member after the object *key*, which would
 * publish `Captured` while REST returns `captured`. Deriving a SCREAMING_CASE
 * key → wire-value map gives the conventional GraphQL spelling (`CAPTURED`)
 * while serialising exactly the same string the REST API uses.
 */
function gqlEnum<T extends Record<string, string>>(source: T): Record<string, string> {
  return Object.fromEntries(Object.values(source).map((value) => [value.toUpperCase(), value]));
}

export const PaymentStatusEnum = gqlEnum(PaymentStatus);
export const PaymentDirectionEnum = gqlEnum(PaymentDirection);

registerEnumType(PaymentStatusEnum, { name: 'PaymentStatus' });
registerEnumType(PaymentDirectionEnum, { name: 'PaymentDirection' });

/**
 * Money in GraphQL.
 *
 * `minor` is a String, not an Int: GraphQL's Int is 32-bit signed, so a
 * balance above ~21 million minor units would overflow. Returning the exact
 * integer as a string plus a pre-formatted `major` keeps both the maths and
 * the UI honest.
 */
@ObjectType('Money')
export class MoneyModel {
  @Field(() => String, { description: 'Exact amount in minor units' })
  minor!: string;

  @Field(() => String, { description: 'Decimal representation, e.g. "19.99"' })
  major!: string;

  @Field(() => String)
  currency!: string;
}

@ObjectType('PageInfo')
export class PageInfoModel {
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;

  @Field(() => Boolean)
  hasMore!: boolean;
}

@ObjectType('PaymentStats')
export class PaymentStatsModel {
  @Field(() => Int)
  totalCount!: number;

  @Field(() => Int)
  capturedCount!: number;

  @Field(() => Int)
  failedCount!: number;

  @Field(() => MoneyModel)
  volume!: MoneyModel;

  @Field(() => MoneyModel)
  fees!: MoneyModel;
}
