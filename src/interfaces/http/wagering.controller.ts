import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SubmitWagerTransaction } from "../../application/wager/submit-wager-transaction";
import type { WagerResult } from "../../application/wager/wager-result";
import { WalletQueries } from "../../application/wallet/wallet-queries";
import { logContext } from "../../infra/observability/log-context";
import { WagerTransactionKind, WagerTransactionStatus } from "../../wagering/domain/wager-transaction";
import { idempotencyKeySchema, parse, uuidParam, ValidationError, wagerPayloadSchema } from "../contracts";
import { type AuthenticatedRequest, ProviderAuthGuard } from "./auth";

const HTTP_STATUS: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  // PENDING nunca é devolvido (a decisão sai na mesma transação). FAILED é
  // terminal e não adianta reenviar, mas é erro nosso, não do provedor.
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Failed]: 500,
};

export function statusFor(result: WagerResult): number {
  if (result.status === WagerTransactionStatus.Processed && result.idempotentReplay) return 200;
  return HTTP_STATUS[result.status];
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
    const key = parse(idempotencyKeySchema, idempotencyKey);
    const payload = parse(wagerPayloadSchema, body);

    const identity = req.providerIdentity;
    if (identity && identity.providerId !== payload.providerId) {
      throw new ValidationError("providerId does not match the authenticated provider");
    }

    const result = await this.submit.execute(
      { ...payload, kind: payload.kind as SubmitKind, idempotencyKey: key },
      { type: "http", correlationId: logContext.get().correlationId ?? key },
    );
    res.status(statusFor(result));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  getTransaction(@Param("transactionId") transactionId: string) {
    return this.queries.transaction(parse(uuidParam, transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.queries.transactionByExternalId(providerId, externalTransactionId);
  }
}

type SubmitKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
