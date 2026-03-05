import bs58 from 'bs58';

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_IX = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

export interface PumpLaunch {
  signature: string;
  mint: string;
  bondingCurve: string;
  creator: string;
  timestamp: number;
}

export function parsePumpCreate(tx: any): PumpLaunch | null {
  try {
    const msg = tx.transaction?.message;
    if (!msg) return null;
    
    for (const ix of msg.instructions || []) {
      const programId = msg.accountKeys[ix.programIdIndex];
      // Convert raw program ID buffer to base58 if necessary
      const programIdStr = typeof programId === 'string' ? programId : bs58.encode(programId);
      
      if (programIdStr !== PUMP_PROGRAM) continue;
      
      const data = Buffer.from(bs58.decode(ix.data));
      if (data.slice(0, 8).equals(CREATE_IX)) {
        return {
          signature: tx.signature,
          mint: typeof msg.accountKeys[ix.accounts[2]] === 'string' ? msg.accountKeys[ix.accounts[2]] : bs58.encode(msg.accountKeys[ix.accounts[2]]),
          bondingCurve: typeof msg.accountKeys[ix.accounts[3]] === 'string' ? msg.accountKeys[ix.accounts[3]] : bs58.encode(msg.accountKeys[ix.accounts[3]]),
          creator: typeof msg.accountKeys[0] === 'string' ? msg.accountKeys[0] : bs58.encode(msg.accountKeys[0]),
          timestamp: Date.now()
        };
      }
    }
  } catch (err) {
    // Silently ignore parse errors to keep stream fast
  }
  return null;
}