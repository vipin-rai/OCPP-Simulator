export interface Transaction {
  id: number | null;
  connectorId: number;
  tagId: string;
  meterStart: number;
  meterStop: number | null;
  startTime: Date;
  stopTime: Date | null;
  meterSent: boolean;
  estimatedCost?: number;
  chargeBoxId?: string;
  pricePerKwh?: number;    
  walletLimit?: number;    
}
