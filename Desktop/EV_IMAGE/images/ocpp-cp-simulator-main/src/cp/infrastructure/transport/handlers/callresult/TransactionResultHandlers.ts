import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

// Global map to store monitoring intervals so StopTransactionResultHandler can clear them
const globalMonitoringIntervals: Map<number, NodeJS.Timeout> = new Map();

export class StartTransactionResultHandler
  implements CallResultHandler<response.StartTransactionResponse>
{
  constructor(private connectorId: number) {}

  handle(
    payload: response.StartTransactionResponse,
    context: HandlerContext,
  ): void {
    const { transactionId, idTagInfo } = payload;
    const connector = context.chargePoint.getConnector(this.connectorId);

    if (idTagInfo.status === "Accepted") {
      if (connector) {
        connector.transactionId = transactionId;
        connector.status = OCPPStatus.Charging;
        
        // ✅ START COST MONITORING (with lock amount)
        let lockAmount = (connector as any).lockAmount || 5.0;
        context.logger.info(`💰 Lock Amount: ₹${lockAmount} | TxID: ${transactionId}`, LogType.TRANSACTION);
        this.startCostMonitoring(transactionId, this.connectorId, lockAmount, context);
        
        // Async: Try to fetch locked_amount from API in background (don't block)
        (async () => {
          try {
            const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';
            const apiUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${transactionId}`;
            const resp = await fetch(apiUrl, { method: 'GET', headers: { 'Accept': 'application/json' }, mode: 'cors' });
            if (resp.ok) {
              const data = await resp.json();
              let apiLocked = data.locked_amount ?? data.lockAmount ?? data.lockamount ?? data.lock_amount;
              if (typeof apiLocked === 'string') apiLocked = parseFloat(apiLocked as string);
              if (typeof apiLocked === 'number' && !isNaN(apiLocked) && apiLocked !== lockAmount) {
                (connector as any).lockAmount = apiLocked;
                context.logger.info(`💰 Updated lock amount from API to: ₹${apiLocked}`, LogType.TRANSACTION);
              }
            }
          } catch (e) {
            // Silently fail - monitoring already started with default/DataTransfer amount
          }
        })();
      }
    } else {
      context.logger.error("Failed to start transaction", LogType.TRANSACTION);
      if (connector) {
        connector.status = OCPPStatus.Faulted;
        if (connector.transaction && connector.transaction.meterSent) {
          context.chargePoint.stopTransaction(connector);
        } else {
          context.chargePoint.cleanTransaction(connector);
        }
      } else {
        context.chargePoint.cleanTransaction(this.connectorId);
      }
      context.chargePoint.updateConnectorStatus(
        this.connectorId,
        OCPPStatus.Available,
      );
    }
  }

  private startCostMonitoring(transactionId: number, connectorId: number, lockAmount: number, context: HandlerContext): void {
    console.log(`🎯 COST MONITORING STARTED: TxID=${transactionId}, ConnID=${connectorId}, LockAmount=₹${lockAmount}`);
    console.log(`📱 Browser hostname: ${typeof window !== 'undefined' ? window.location.hostname : 'N/A'}`);
    context.logger.info(`=== COST MONITORING SESSION START ===`, LogType.TRANSACTION);
    context.logger.info(`Transaction: ${transactionId} | Connector: ${connectorId} | Lock Limit: ₹${lockAmount}`, LogType.TRANSACTION);

    const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';
    
    let isStopped = false;
    let checkCount = 0;

    const interval = setInterval(async () => {
      checkCount++;
      const timestamp = new Date().toLocaleTimeString();
      console.log(`⏰ CHECK #${checkCount} at ${timestamp}`);

      if (isStopped) {
        console.log(`⛔ Monitoring already stopped for tx ${transactionId}`);
        clearInterval(interval);
        return;
      }

      try {
        // Always use backend URL - don't use relative path since dev server doesn't proxy this
        const apiUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${transactionId}`;
        console.log(`🌐 FETCHING: ${apiUrl}`);
        console.log(`   📍 TransactionID: ${transactionId}, ConnectorID: ${connectorId}, LockAmount: ₹${lockAmount}`);
        context.logger.info(`[Check #${checkCount}] API Call - TxID=${transactionId}, Conn=${connectorId}, Lock=₹${lockAmount}`, LogType.TRANSACTION);
        context.logger.info(`[Check #${checkCount}] Fetching from: ${apiUrl}`, LogType.TRANSACTION);

        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          mode: 'cors'
        });

        console.log(`📡 Response status: ${response.status} ${response.statusText}`);
        context.logger.info(`[Check #${checkCount}] HTTP ${response.status}`, LogType.TRANSACTION);

        if (!response.ok) {
          console.error(`❌ API ERROR: ${response.status} ${response.statusText}`);
          const errorText = await response.text();
          console.error('Error body:', errorText.substring(0, 200));
          context.logger.error(`[Check #${checkCount}] API ERROR ${response.status}: ${errorText.substring(0, 100)}`, LogType.TRANSACTION);
          return;
        }

        const data = await response.json();
        console.log(`📊 API RESPONSE:`, JSON.stringify(data, null, 2));

        if (!data || typeof data !== 'object') {
          console.warn('⚠️ Invalid API response structure');
          context.logger.warn(`[Check #${checkCount}] Invalid response structure`, LogType.TRANSACTION);
          return;
        }

        const currentRevenue = data.revenue_amount;
        const apiStatus = data.status;

        if (typeof currentRevenue !== 'number' || currentRevenue === null || currentRevenue === undefined) {
          console.warn(`⚠️ Missing or invalid revenue_amount in response:`, data);
          context.logger.warn(`[Check #${checkCount}] Invalid revenue_amount: ${currentRevenue}`, LogType.TRANSACTION);
          return;
        }

        console.log(`💵 REVENUE CHECK: ₹${currentRevenue} / Lock: ₹${lockAmount} | Status: ${apiStatus}`);
        console.log(`   ✓ currentRevenue=${currentRevenue} (type: ${typeof currentRevenue})`);
        console.log(`   ✓ lockAmount=${lockAmount} (type: ${typeof lockAmount})`);
        console.log(`   ✓ Comparison: ${currentRevenue} >= ${lockAmount} = ${currentRevenue >= lockAmount}`);
        context.logger.info(`[Check #${checkCount}] Revenue: ₹${currentRevenue} (Limit: ₹${lockAmount}) | API Status: ${apiStatus}`, LogType.TRANSACTION);

        // CRITICAL: If revenue >= lock amount, STOP IMMEDIATELY
        if (currentRevenue >= lockAmount) {
          console.log(`💰💥 ⚡ LIMIT REACHED! Revenue ₹${currentRevenue} >= Lock ₹${lockAmount} - STOPPING NOW!`);
          context.logger.error(`💥 CHARGING LIMIT REACHED! ₹${currentRevenue} >= ₹${lockAmount}`, LogType.TRANSACTION);
          
          isStopped = true;
          clearInterval(interval);
          context.logger.info(`🛑 Cleared monitoring interval - preparing auto-stop`, LogType.TRANSACTION);
          
          // Trigger auto-stop
          const connector = context.chargePoint.getConnector(connectorId);
          if (connector && connector.transaction) {
            console.log(`🛑 AUTO-STOP TRIGGERED: TxID=${transactionId}, Revenue=₹${currentRevenue}, Lock=₹${lockAmount}`);
            context.logger.error(`🛑 AUTO-STOP INITIATED for transaction ${transactionId}`, LogType.TRANSACTION);
            context.chargePoint.stopTransaction(connector);
            console.log(`✅ AUTO-STOP COMPLETE! Transaction ${transactionId} stopped.`);
            context.logger.error(`✅ AUTO-STOP COMPLETE! Charging stopped for transaction ${transactionId}`, LogType.TRANSACTION);
          }
          return;
        } else {
          const remaining = (lockAmount - currentRevenue).toFixed(2);
          console.log(`⏳ Continuing... Remaining: ₹${remaining}`);
          context.logger.debug(`[Check #${checkCount}] Remaining: ₹${remaining}`, LogType.TRANSACTION);
        }

      } catch (error) {
        console.error(`💥 FETCH ERROR:`, error);
        context.logger.error(`[Check #${checkCount}] Exception: ${error instanceof Error ? error.message : String(error)}`, LogType.TRANSACTION);
      }
    }, 10000); // Check every 10 seconds

    // Store interval globally so StopTransactionResultHandler can clear it
    globalMonitoringIntervals.set(transactionId, interval);

    console.log(`✅ Monitoring started | Interval: 10 seconds`);
    context.logger.info(`✅ Monitoring started - checks every 10 seconds`, LogType.TRANSACTION);
  }
}

export class StopTransactionResultHandler
  implements CallResultHandler<response.StopTransactionResponse>
{
  constructor(private connectorId: number) {}

  handle(
    payload: response.StopTransactionResponse,
    context: HandlerContext,
  ): void {
    context.logger.info(
      `Transaction stopped successfully: ${JSON.stringify(payload)}`,
      LogType.TRANSACTION,
    );
    const connector = context.chargePoint.getConnector(this.connectorId);
    if (connector && connector.transactionId) {
      // ✅ STOP MONITORING when charging ends
      const txId = connector.transactionId;
      if (globalMonitoringIntervals.has(txId)) {
        const interval = globalMonitoringIntervals.get(txId);
        if (interval) clearInterval(interval);
        globalMonitoringIntervals.delete(txId);
        console.log(`🛑 Monitoring stopped for tx ${txId}`);
        context.logger.info(`🛑 Monitoring stopped for transaction ${txId}`, LogType.TRANSACTION);
      }
    }
    if (connector) {
      connector.transactionId = null;
      connector.stopTransaction();
      context.chargePoint.updateConnectorStatus(
        this.connectorId,
        OCPPStatus.Available,
      );
    }
  }
}

export class AuthorizeResultHandler
  implements CallResultHandler<response.AuthorizeResponse>
{
  handle(
    payload: response.AuthorizeResponse,
    context: HandlerContext,
  ): void {
    const { idTagInfo } = payload;
    if (idTagInfo.status === "Accepted") {
      context.logger.info("Authorization successful", LogType.TRANSACTION);
    } else {
      context.logger.warn("Authorization failed", LogType.TRANSACTION);
    }
  }
}
