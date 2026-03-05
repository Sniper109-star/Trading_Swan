import { PumpFunSDK } from "pumpdotfun-sdk";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { PrismaClient, Position } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();

export class TradingEngine {
  public wallet: Keypair;
  private sdk: PumpFunSDK;
  private conn: Connection;

  constructor(privateKeyBase64: string, rpcUrl: string) {
    this.wallet = Keypair.fromSecretKey(Buffer.from(privateKeyBase64, "base64"));
    this.conn = new Connection(rpcUrl, "confirmed");
    // Cast as any due to sdk internal versioning mismatches with standard web3.js
    this.sdk = new PumpFunSDK({ connection: this.conn, wallet: this.wallet } as any);
  }

  async buy(launch: any) {
    try {
      const config = await prisma.config.findFirst({ where: { enabled: true } });
      if (!config) return;
      
      const buyLamports = BigInt(Math.floor(config.buyAmountSol * 1_000_000_000));
      const txResult = await this.sdk.buy(this.wallet, new PublicKey(launch.mint), buyLamports, 500n);
      
      if (!txResult || !txResult.tx) throw new Error("Buy transaction generation failed");
      
      const sig = await this.sendViaHeliusSender(txResult.tx);
      console.log(`🚀 BOUGHT ${launch.mint} | Sig: ${sig}`);

      // Assuming a default user exists for this MVP
      let user = await prisma.user.findFirst();
      if (!user) {
         user = await prisma.user.create({ data: { wallet: this.wallet.publicKey.toString() } });
      }

      const position = await prisma.position.create({
        data: { 
          userId: user.id, 
          mint: launch.mint, 
          bondingCurve: launch.bondingCurve, 
          entryPrice: 0, // Should be updated upon confirmation
          amount: Number(buyLamports)/1e9, 
          entrySol: config.buyAmountSol, 
          peakPrice: 0 
        }
      });
      
      (globalThis as any).io?.emit("new-position", position);
      return position;
    } catch (error) {
      console.error("Error executing buy:", error);
    }
  }

  async sell(position: Position, currentPrice: number, reason: string) {
    try {
      let sig: string;
      const tokenAmount = BigInt(Math.floor(position.amount * 1_000_000_000));

      if (reason !== "complete") {
        // Sell via Pump.fun curve
        const txResult = await this.sdk.sell(this.wallet, new PublicKey(position.mint), tokenAmount, 500n);
        if (!txResult || !txResult.tx) throw new Error("Sell transaction generation failed");
        sig = await this.sendViaHeliusSender(txResult.tx);
      } else {
        // Sell via Jupiter once graduated
        const quote = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${position.mint}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenAmount}&slippageBps=500&dexes=Meteora,Raydium,PumpSwap`);
        const swap = await axios.post("https://quote-api.jup.ag/v6/swap", { 
          quoteResponse: quote.data, 
          userPublicKey: this.wallet.publicKey.toString(), 
          wrapAndUnwrapSol: true 
        });
        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, "base64"));
        sig = await this.sendViaHeliusSender(tx);
      }

      const updatedPos = await prisma.position.update({ 
        where: { id: position.id }, 
        data: { status: "sold", exitPrice: currentPrice, exitSignature: sig } 
      });
      
      console.log(`💰 SOLD ${position.mint} | Reason: ${reason} | Sig: ${sig}`);
      (globalThis as any).io?.emit("position-sold", { ...updatedPos, reason });
    } catch (error) {
      console.error("Error executing sell:", error);
    }
  }

  private async sendViaHeliusSender(tx: VersionedTransaction): Promise<string> {
    const serialized = Buffer.from(tx.serialize()).toString("base64");
    const rpcUrl = process.env.HELIUS_RPC?.replace("mainnet", "sender"); // Using fast sender url if applicable
    
    const res = await fetch(rpcUrl || "https://sender.helius-rpc.com/fast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        jsonrpc: "2.0", 
        id: Date.now(), 
        method: "sendTransaction", 
        params: [serialized, { skipPreflight: true, maxRetries: 0 }] 
      })
    });
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  }
}