import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get port(): number {
    return this.configService.getOrThrow<number>('app.port');
  }

  get databaseUrl(): string {
    return this.configService.getOrThrow<string>('database.url');
  }
}
