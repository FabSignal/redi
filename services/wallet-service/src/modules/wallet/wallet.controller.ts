import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import { WalletService } from "./wallet.service.js";

class WalletEmailDto {
  @IsEmail()
  email!: string;
}

class WalletNativeStateDto {
  @IsString()
  @MinLength(1)
  publicKey!: string;
}

@Controller("/api/buffer")
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post("/wallet/provision")
  provisionWallet(@Body() dto: WalletEmailDto) {
    return this.walletService.provisionWallet(dto.email);
  }

  @Post("/wallet/state")
  getWalletState(@Body() dto: WalletEmailDto) {
    return this.walletService.getWalletState(dto.email);
  }

  @Post("/wallet/native-state")
  getWalletNativeState(@Body() dto: WalletNativeStateDto) {
    return this.walletService.getNativeState(dto.publicKey);
  }
}
