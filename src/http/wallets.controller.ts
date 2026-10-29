import { Body, Controller, Get, HttpException, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import type { MoneyProps } from "../shared/money";
import { CreateWallet } from "../wallet/application/create-wallet";
import { WalletQueries } from "../wallet/application/wallet-queries";
import { toHttpException } from "./errors";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  async create(@Body() body: { playerId: string; initialBalance: MoneyProps }) {
    try {
      return await this.createWallet.execute(body);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.queries.wallet(walletId);
    if (!wallet) throw new HttpException({ code: "WALLET_NOT_FOUND" }, HttpStatus.NOT_FOUND);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limitRaw: string | undefined,
  ) {
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
    try {
      const page = await this.queries.ledger(walletId, cursor, limit);
      if (!page) throw new HttpException({ code: "WALLET_NOT_FOUND" }, HttpStatus.NOT_FOUND);
      return page;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException({ code: "INVALID_PAYLOAD", message: "cursor inválido" }, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.queries.reconcile(walletId);
    if (!result) throw new HttpException({ code: "WALLET_NOT_FOUND" }, HttpStatus.NOT_FOUND);
    return result;
  }
}
