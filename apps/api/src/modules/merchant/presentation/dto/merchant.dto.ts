import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiScope } from '../../../identity/domain/api-key.aggregate.js';

export class OnboardMerchantDto {
  @ApiProperty({ example: 'Acme Payments' })
  @IsString()
  @Length(2, 160)
  name!: string;

  @ApiPropertyOptional({ example: ['USD', 'EUR'], default: ['USD', 'EUR'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  supportedCurrencies?: string[];
}

export class ConfigureWebhookDto {
  @ApiProperty({ example: 'https://merchant.example.com/payhub/webhooks' })
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  url!: string;

  @ApiPropertyOptional({ example: ['payment.captured.v1', 'payment.failed.v1'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  events?: string[];

  @ApiPropertyOptional({
    description: 'Allow a plain-HTTP endpoint. Only accepted outside production.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowInsecure?: boolean;
}

export class UpdateFeePolicyDto {
  @ApiProperty({ example: 290, description: 'Basis points: 290 = 2.90 %' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  basisPoints!: number;

  @ApiPropertyOptional({ example: '30', description: 'Flat component in minor units' })
  @IsOptional()
  @IsNumberString()
  fixedMinor?: string;

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @IsNumberString()
  minimumMinor?: string;

  @ApiPropertyOptional({ example: '10000' })
  @IsOptional()
  @IsNumberString()
  maximumMinor?: string;
}

export class CreateApiKeyDto {
  @ApiProperty({ example: 'production-server' })
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ enum: ApiScope, isArray: true, example: [ApiScope.PaymentsWrite] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  scopes!: string[];

  @ApiPropertyOptional({ enum: ['live', 'test'], default: 'test' })
  @IsOptional()
  @IsString()
  environment?: 'live' | 'test';
}
