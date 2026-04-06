import { Module } from "@nestjs/common";
import { WalletController } from "./wallet.controller.js";
import { WalletService } from "./wallet.service.js";

@Module({
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
