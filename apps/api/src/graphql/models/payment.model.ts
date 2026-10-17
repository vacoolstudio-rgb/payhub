import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLISODateTime } from '@nestjs/graphql';
import type {
  PaymentDirection,
  PaymentStatus,
} from '../../modules/payment/domain/payment.aggregate.js';
import {
  MoneyModel,
  PageInfoModel,
  PaymentDirectionEnum,
  PaymentStatusEnum,
} from './common.model.js';

@ObjectType('Merchant')
export class MerchantModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  status!: string;
}

@ObjectType('Payment')
export class PaymentModel {
  @Field(() => ID)
  id!: string;

  @Field(() => PaymentStatusEnum)
  status!: PaymentStatus;

  @Field(() => PaymentDirectionEnum)
  direction!: PaymentDirection;

  @Field(() => MoneyModel)
  amount!: MoneyModel;

  @Field(() => MoneyModel)
  fee!: MoneyModel;

  @Field(() => MoneyModel)
  netAmount!: MoneyModel;

  @Field()
  method!: string;

  @Field()
  reference!: string;

  @Field(() => String, { nullable: true })
  failureReason!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  capturedAt!: Date | null;

  /** Resolved through a DataLoader, never with a per-row query. */
  @Field(() => MerchantModel, { nullable: true })
  merchant?: MerchantModel | null;

  /** Internal: the field resolver needs it, the schema does not expose it. */
  merchantId!: string;
}

@ObjectType('PaymentPage')
export class PaymentPageModel {
  @Field(() => [PaymentModel])
  items!: PaymentModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;
}

@ObjectType('Wallet')
export class WalletModel {
  @Field(() => ID)
  id!: string;

  @Field()
  currency!: string;

  @Field(() => MoneyModel)
  available!: MoneyModel;

  @Field(() => MoneyModel)
  pending!: MoneyModel;

  @Field(() => MoneyModel)
  total!: MoneyModel;

  @Field()
  status!: string;
}

@ObjectType('StatementEntry')
export class StatementEntryModel {
  @Field(() => ID)
  transferId!: string;

  @Field()
  purpose!: string;

  @Field()
  description!: string;

  @Field()
  direction!: string;

  @Field(() => MoneyModel)
  amount!: MoneyModel;

  @Field(() => GraphQLISODateTime)
  postedAt!: Date;

  @Field(() => String, { nullable: true })
  paymentId!: string | null;
}
