import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PaymentProviderKey } from '@bizbot/payments';
import { createPaymentSchema } from '@bizbot/contracts';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  CurrentActor, CustomerRoute, Lang, Public, RequireModule, RequirePermission,
} from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { PaymentsService } from './payments.service';

/**
 * Payment webhooks.
 *
 * @Public because the provider has no session; authenticity is the provider signature,
 * checked inside the service before anything is read as meaningful. The response body is
 * whatever that provider expects — Payme in particular requires an exact JSON-RPC shape,
 * and returning the wrong one makes it retry forever or cancel a good transaction.
 */
@Controller('payments')
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('webhook/:provider/:integrationId')
  async webhook(
    @Param('provider') provider: string,
    @Param('integrationId') integrationId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, string>,
  ) {
    const result = await this.payments.handleWebhook(
      provider as PaymentProviderKey,
      integrationId,
      {
        // The raw bytes, preserved by the body parser: an HMAC over a reserialized body
        // would not match, because JSON key order is not stable.
        rawBody: req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})),
        headers: req.headers as Record<string, string | undefined>,
        parsedBody: req.body,
        query,
      },
    );
    res.status(result.status).json(result.body);
  }
}

@Controller('shop/payments')
@CustomerRoute()
@RequireModule('PAYMENTS')
export class CustomerPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @Body(zodBody(createPaymentSchema)) dto: { orderId?: string; method: string; returnUrl?: string },
    @Lang() lang: 'uz' | 'ru' | 'en',
  ) {
    return this.payments.createForOrder(dto.orderId!, dto.method, { returnUrl: dto.returnUrl, language: lang });
  }
}

@Controller('t/:tenantId/payments')
@RequireModule('PAYMENTS')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('order/:orderId')
  @RequirePermission('order:read')
  forOrder(@Param('orderId') orderId: string) {
    return this.payments.listForOrder(orderId);
  }

  @Post('order/:orderId/cash')
  @RequirePermission('order:status')
  markCashPaid(@CurrentActor() actor: RequestActor, @Param('orderId') orderId: string) {
    return this.payments.markCashPaid(actor.userId!, orderId);
  }
}
