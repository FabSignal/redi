import { type Request, type Response } from "express";
import { z } from "zod";
import { BufferService } from "./buffer.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";

// Esquemas de validación de entrada
const getBalanceSchema = z.object({
  userId: z.string().uuid(),
});

const depositSchema = z.object({
  userId: z.string().uuid(),
  amountStroops: z.string().regex(/^\d+$/, "Must be a numeric string"),
});

const withdrawSchema = z.object({
  userId: z.string().uuid(),
  sharesAmount: z.string().regex(/^\d+$/, "Must be a numeric string"),
});

export class BufferController {
  constructor(
    private readonly bufferService: BufferService,
    private readonly supabaseService: SupabaseService,
    private readonly crossmintService: CrossmintService,
  ) {}

  // GET /api/buffer/balance
  async getBalance(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = getBalanceSchema.parse(req.body);

      const user = await this.supabaseService.getUser(userId);
      if (!user.stellar_address) {
        res.status(400).json({ error: "User has no stellar address. Complete onboarding first." });
        return;
      }

      const balance = await this.bufferService.getBalance(user.stellar_address as string);
      res.json({ userId, balance });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[BufferController] getBalance failed: ${error.message}`);
      res.status(500).json({ error: "Failed to get buffer balance" });
    }
  }

  // POST /api/buffer/deposit/prepare
  // Construye el XDR sin firmarlo — Crossmint lo firma por el usuario
  async prepareDeposit(req: Request, res: Response): Promise<void> {
    try {
      const { userId, amountStroops } = depositSchema.parse(req.body);

      const user = await this.supabaseService.getUser(userId);
      if (!user.stellar_address) {
        res.status(400).json({ error: "User has no stellar address. Complete onboarding first." });
        return;
      }

      const transactionXDR = await this.bufferService.buildDepositTransaction(
        user.stellar_address as string,
        amountStroops,
      );

      // Registrar intento en ledger off-chain antes de firmar
      const txId = await this.supabaseService.createBufferTransaction({
        userId,
        transactionType: "DEPOSIT",
        amountStroops: Number(amountStroops),
        status: "PENDING",
      });

      res.json({ transactionXDR, txId });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[BufferController] prepareDeposit failed: ${error.message}`);
      res.status(500).json({ error: "Failed to prepare deposit transaction" });
    }
  }

  // POST /api/buffer/deposit/submit
  // Recibe el XDR preparado, Crossmint lo firma y lo submite
  async submitDeposit(req: Request, res: Response): Promise<void> {
    try {
      const schema = z.object({
        userId: z.string().uuid(),
        walletId: z.string().min(1),
        transactionXDR: z.string().min(1),
        txId: z.string().uuid(),
      });

      const { userId, walletId, transactionXDR, txId } = schema.parse(req.body);

      const result = await this.crossmintService.signAndSubmitTransaction({
        walletId,
        transactionXDR,
      });

      await this.supabaseService.updateBufferTransaction(txId, {
        stellarTxHash: result.transactionHash,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      });

      res.json({ transactionHash: result.transactionHash, txId });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[BufferController] submitDeposit failed: ${error.message}`);
      res.status(500).json({ error: "Failed to submit deposit" });
    }
  }

  // POST /api/buffer/withdraw/prepare
  async prepareWithdraw(req: Request, res: Response): Promise<void> {
    try {
      const { userId, sharesAmount } = withdrawSchema.parse(req.body);

      const user = await this.supabaseService.getUser(userId);
      if (!user.stellar_address) {
        res.status(400).json({ error: "User has no stellar address. Complete onboarding first." });
        return;
      }

      const transactionXDR = await this.bufferService.buildWithdrawTransaction(
        user.stellar_address as string,
        sharesAmount,
      );

      const txId = await this.supabaseService.createBufferTransaction({
        userId,
        transactionType: "WITHDRAW",
        sharesDelta: Number(sharesAmount),
        status: "PENDING",
      });

      res.json({ transactionXDR, txId });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[BufferController] prepareWithdraw failed: ${error.message}`);
      res.status(500).json({ error: "Failed to prepare withdraw transaction" });
    }
  }

  // POST /api/buffer/withdraw/submit
  async submitWithdraw(req: Request, res: Response): Promise<void> {
    try {
      const schema = z.object({
        userId: z.string().uuid(),
        walletId: z.string().min(1),
        transactionXDR: z.string().min(1),
        txId: z.string().uuid(),
      });

      const { userId, walletId, transactionXDR, txId } = schema.parse(req.body);

      const result = await this.crossmintService.signAndSubmitTransaction({
        walletId,
        transactionXDR,
      });

      await this.supabaseService.updateBufferTransaction(txId, {
        stellarTxHash: result.transactionHash,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      });

      res.json({ transactionHash: result.transactionHash, txId });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[BufferController] submitWithdraw failed: ${error.message}`);
      res.status(500).json({ error: "Failed to submit withdraw" });
    }
  }
}
