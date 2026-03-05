import Client, { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import bs58 from 'bs58';

export class StreamManager {
  private client: Client;
  private stream: any;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 1000;

  constructor(
    private endpoint: string,
    private apiKey: string,
    private onData: (data: any) => void,
    private onError?: (error: any) => void
  ) {
    this.client = new Client(endpoint, apiKey, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024
    });
  }

  async connect(subscribeRequest: SubscribeRequest): Promise<void> {
    try {
      console.log(`Connecting to ${this.endpoint}...`);
      this.stream = await this.client.subscribe();
      this.isConnected = true;
      this.reconnectAttempts = 0;

      this.stream.on("data", this.handleData.bind(this));
      this.stream.on("error", this.handleStreamError.bind(this));
      this.stream.on("end", () => this.handleDisconnect(subscribeRequest));
      this.stream.on("close", () => this.handleDisconnect(subscribeRequest));

      await this.writeRequest(subscribeRequest);
      this.startKeepalive();
      console.log("✅ gRPC Connected and subscribed successfully");
    } catch (error) {
      console.error("gRPC Connection failed:", error);
      await this.reconnect(subscribeRequest);
    }
  }

  private async writeRequest(request: SubscribeRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(request, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleData(data: any): void {
    try {
      const processedData = this.processBuffers(data);
      this.onData(processedData);
    } catch (error) {
      console.error("Error processing gRPC data:", error);
    }
  }

  private processBuffers(obj: any): any {
    if (!obj) return obj;
    if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
      return bs58.encode(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.processBuffers(item));
    }
    if (typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k, this.processBuffers(v)])
      );
    }
    return obj;
  }

  private handleStreamError(error: any): void {
    console.error("Stream error:", error);
    this.isConnected = false;
    if (this.onError) this.onError(error);
  }

  private async handleDisconnect(subscribeRequest: SubscribeRequest): Promise<void> {
    if (this.isConnected) {
      console.log("Stream disconnected, attempting to reconnect...");
      this.isConnected = false;
      await this.reconnect(subscribeRequest);
    }
  }

  private async reconnect(subscribeRequest: SubscribeRequest): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached. Giving up.");
      return;
    }
    this.reconnectAttempts++;
    const delay = this.baseReconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5));
    console.log(`Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
    setTimeout(() => {
      this.connect(subscribeRequest).catch(console.error);
    }, delay);
  }

  private startKeepalive(): void {
    setInterval(() => {
      if (this.isConnected) {
        const pingRequest: SubscribeRequest = {
          ping: { id: Date.now() },
          accounts: {},
          accountsDataSlice: [],
          transactions: {},
          slots: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          transactionsStatus: {}
        };
        this.writeRequest(pingRequest).catch(console.error);
      }
    }, 30000);
  }

  disconnect(): void {
    if (this.stream) this.stream.end();
    this.client.close();
    this.isConnected = false;
  }
}