import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessModule } from '../business.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramAuthService } from './telegram-auth.service';
import { TelegramUpdateRouter } from './telegram-update.router';
import { TelegramSender } from './telegram-sender.service';
import {
  TelegramGatewayController, MiniAppAuthController, TelegramAdminController,
} from './telegram.controller';

@Module({
  imports: [AuthModule, BusinessModule],
  providers: [TelegramBotService, TelegramAuthService, TelegramUpdateRouter, TelegramSender],
  controllers: [TelegramGatewayController, MiniAppAuthController, TelegramAdminController],
  exports: [TelegramBotService, TelegramSender],
})
export class TelegramModule {}
