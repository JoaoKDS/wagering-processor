/**
 * Registro de recebimento de mensagem (spec, seção 6.5). Único por (consumerName, messageId),
 * gravado na mesma transação SQL da alteração financeira. Imutável.
 */
export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface ReceiveInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  /** Recebimento novo, ainda não processado. */
  static receive(input: ReceiveInput): InboxMessage {
    return new InboxMessage({ ...input, processedAt: null });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get consumerName(): string { return this.state.consumerName; }
  get messageId(): string { return this.state.messageId; }
  get payloadHash(): string { return this.state.payloadHash; }
  get receivedAt(): Date { return this.state.receivedAt; }
  get processedAt(): Date | null { return this.state.processedAt; }

  isProcessed(): boolean {
    return this.state.processedAt !== null;
  }

  markProcessed(at: Date): InboxMessage {
    return new InboxMessage({ ...this.state, processedAt: at });
  }
}
