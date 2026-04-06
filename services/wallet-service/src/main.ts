import "reflect-metadata";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import helmet from "helmet";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RuntimeConfigService } from "./common/config/runtime-config.service.js";
import { AppExceptionFilter } from "./common/filters/app-exception.filter.js";
import { appLogger, loggerMiddleware } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

async function bootstrap(): Promise<void> {
  const { AppModule } = await import("./app.module.js");
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const runtimeConfig = app.get(RuntimeConfigService);

  app.use(helmet());
  app.use(loggerMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(app.get(AppExceptionFilter));
  app.enableCors({
    credentials: false,
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (runtimeConfig.corsAllowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS: origin not allowed: ${origin}`), false);
    },
  });
  app.enableShutdownHooks();

  await app.listen(runtimeConfig.walletServicePort);
  appLogger.info(
    { port: runtimeConfig.walletServicePort, service: "wallet-service" },
    "wallet-service listening",
  );
}

void bootstrap();
