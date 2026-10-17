import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'ada@payhub.dev', maxLength: 254 })
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  email!: string;

  /**
   * Length beats composition rules: NIST SP 800-63B dropped the
   * "one uppercase, one symbol" requirement because it pushes users towards
   * predictable substitutions. A 12-character minimum with a blocklist of
   * breached passwords is the modern guidance.
   */
  @ApiProperty({ example: 'correct horse battery staple', minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128, { message: 'Password must be between 12 and 128 characters' })
  @Matches(/^(?!\s)(?!.*\s$).*$/, { message: 'Password must not start or end with whitespace' })
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  @Transform(({ value }: { value: string }) => value?.trim())
  displayName!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@payhub.dev' })
  @IsEmail()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Omit when the refresh token is sent as an httpOnly cookie, which is the recommended browser flow.',
  })
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({
    description:
      'Returned in the body for non-browser clients; browsers receive it as an httpOnly, SameSite=Strict cookie instead.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds' })
  expiresIn!: number;

  @ApiProperty()
  user!: { id: string; email: string; displayName: string; roles: readonly string[] };
}
