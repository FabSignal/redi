import request from "supertest";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthModule } from "../src/modules/health/health.module.js";

describe("HealthController", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the health payload", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);

    expect(response.body.service).toBe("wallet-service");
    expect(response.body.status).toBe("ok");
    expect(typeof response.body.timestamp).toBe("string");
  });
});
