import { Module } from "@nestjs/common";
import { BufferController } from "./buffer.controller.js";
import { BufferApplicationService } from "./buffer.application.service.js";

@Module({
  controllers: [BufferController],
  providers: [BufferApplicationService],
})
export class BufferModule {}
