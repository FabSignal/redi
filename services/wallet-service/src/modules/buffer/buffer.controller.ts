import { Body, Controller, Post } from "@nestjs/common";
import { IsUUID, Matches } from "class-validator";
import { BufferApplicationService } from "./buffer.application.service.js";

class BufferBalanceDto {
  @IsUUID()
  userId!: string;
}

class PrepareDepositDto {
  @IsUUID()
  userId!: string;

  @Matches(/^\d+$/)
  amountStroops!: string;
}

class PrepareWithdrawDto {
  @IsUUID()
  userId!: string;

  @Matches(/^\d+$/)
  sharesAmount!: string;
}

@Controller("/api/buffer")
export class BufferController {
  constructor(private readonly bufferApplicationService: BufferApplicationService) {}

  @Post("/balance")
  getBalance(@Body() dto: BufferBalanceDto) {
    return this.bufferApplicationService.getBalance(dto.userId);
  }

  @Post("/deposit/prepare")
  prepareDeposit(@Body() dto: PrepareDepositDto) {
    return this.bufferApplicationService.prepareDeposit(dto.userId, dto.amountStroops);
  }

  @Post("/deposit/submit")
  submitDeposit(@Body() payload: unknown) {
    return this.bufferApplicationService.confirmDeposit(payload);
  }

  @Post("/withdraw/prepare")
  prepareWithdraw(@Body() dto: PrepareWithdrawDto) {
    return this.bufferApplicationService.prepareWithdraw(dto.userId, dto.sharesAmount);
  }

  @Post("/withdraw/submit")
  submitWithdraw(@Body() payload: unknown) {
    return this.bufferApplicationService.confirmWithdraw(payload);
  }
}
