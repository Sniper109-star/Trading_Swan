import { StreamManager } from "./stream-manager";
import { SubscribeRequest, CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { PrismaClient, Position } from "@prisma/client";
import { TradingEngine } from "./trading-engine";
import bs58 from "bs58";

const prisma = new PrismaClient();

export class PositionMonitor {
  private stream: StreamManager;
  private peaks = new Map<string, number>();

  constructor(endpoint: string, apiKey: string, private engine: TradingEngine) {
    this.stream = new StreamManager(endpoint, apiKey, this.handleUpdate.bind(this));
  }

  async monitor(position: Position) {
    const req: SubscribeRequest = {
      accounts: { 
        curves: { 
          account: [position.bondingCurve], 
          owner: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] 
        } 
      },
      commitment: CommitmentLevel.CONFIRMED
    } as any;
    
    await this.stream.connect(req);
    this.peaks.set(position.bondingCurve, position.entryPrice || 0);
  }

  private async handleUpdate(data: any) {
    if (!data.account) return;
    const pubkey = data.account.pubkey; // Should already be stringified via stream-manager
    
    let buf: Buffer;
    try {
      buf = Buffer.from(bs58.decode(data.account.account.data));
    } catch (e) { return; }

    const reserves = this.decodeBondingCurve(buf);
    if (!reserves) return;

    const solReserves = Number(reserves.solReserves) / 1e9;
    const tokenReserves = Number(reserves.tokenReserves) / 1e9;
    const currentPrice = solReserves / tokenReserves;

    const position = await prisma.position.findFirst({
      where: { bondingCurve: pubkey, status: "open" }
    });

    if (!position) return;

    const peak = this.peaks.get(pubkey) || position.peakPrice;
    const newPeak = Math.max(peak, currentPrice);
    this.peaks.set(pubkey, newPeak);

    await prisma.position.update({
      where: { id: position.id },
      data: { currentPrice, peakPrice: newPeak }
    });

    // Check TP/SL/Trailing
    const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const trailingTrigger = newPeak * (1 - position.trailingPercent / 100);

    if (profitPercent >= position.tpPercent) {
      await this.engine.sell(position, currentPrice, "tp");
    } else if (profitPercent <= -position.slPercent) {
      await this.engine.sell(position, currentPrice, "sl");
    } else if (currentPrice <= trailingTrigger && newPeak > position.entryPrice) {
      await this.engine.sell(position, currentPrice, "trailing");
    }

    (globalThis as any).io?.emit("price-update", { mint: position.mint, price: currentPrice, peak: newPeak });
  }

  private decodeBondingCurve(buf: Buffer): any {
    try {
      // Simplified - real implementation needs full bonding curve decoding
      const solReserves = buf.readBigUInt64LE(32);
      const tokenReserves = buf.readBigUInt64LE(40);
      return { solReserves, tokenReserves };
    } catch (e) {
      return null;
    }
  }
}