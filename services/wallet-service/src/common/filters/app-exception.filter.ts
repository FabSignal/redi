import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { appLogger } from "../../logger.js";
import { AppError } from "../errors/app-error.js";

@Injectable()
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppError) {
      response.status(exception.statusCode).json({
        errorCode: exception.errorCode,
        message: exception.message,
        details: exception.details,
      });
      return;
    }

    if (exception instanceof ZodError) {
      response.status(400).json({
        errorCode: "INVALID_REQUEST",
        message: "Invalid request payload.",
        details: exception.flatten(),
      });
      return;
    }

    if (exception instanceof BadRequestException) {
      response.status(400).json({
        errorCode: "INVALID_REQUEST",
        message: "Invalid request payload.",
        details: exception.getResponse(),
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        errorCode: "HTTP_EXCEPTION",
        message: exception.message,
        details: exception.getResponse(),
      });
      return;
    }

    appLogger.error({ err: exception }, "request.unhandled_exception");
    response.status(500).json({
      errorCode: "INTERNAL_ERROR",
      message: "Internal server error",
    });
  }
}
