import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CreateWallet } from "../../application/wallet/create-wallet";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet";
import { WalletQueries } from "../../application/wallet/wallet-queries";
import { logContext } from "../../infra/observability/log-context";
import { newId } from "../../shared/domain/ids";
import { createWalletSchema, ledgerQuerySchema, parse, uuidParam } from "../contracts";
import { ProviderAuthGuard } from "./auth";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WalletQueries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    const input = parse(createWalletSchema, body);
    return this.createWallet.execute(input, logContext.get().correlationId ?? newId());
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.queries.wallet(parse(uuidParam, walletId));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query);
    return this.queries.ledger(parse(uuidParam, walletId), cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconciliation(@Param("walletId") walletId: string) {
    return this.reconcile.execute(parse(uuidParam, walletId));
  }
}
