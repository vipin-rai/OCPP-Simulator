import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

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
        // Keep status in CHARGING here; monitoring will update based on API if needed
        connector.status = OCPPStatus.Charging;

        // Do NOT use any pre-existing connector.lockAmount (it may be a default or
        // set by non-authoritative sources). Start monitoring which will poll the
        // transaction API and only apply the lock amount when `locked_amount` is
        // present in the API response.
        context.logger.info(`Starting monitoring for TxID=${transactionId} on connector ${this.connectorId} (waiting for API locked_amount)`, LogType.TRANSACTION);
        this.startCostMonitoring(transactionId, this.connectorId, undefined, context);
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

  private startCostMonitoring(transactionId: number, connectorId: number, _lockAmount: number | undefined, context: HandlerContext): void {
    context.logger.info(`=== COST MONITORING SESSION START ===`, LogType.TRANSACTION);
    context.logger.info(`Transaction: ${transactionId} | Connector: ${connectorId} | Waiting for API locked_amount`, LogType.TRANSACTION);

    const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';

    let isStopped = false;
    let checkCount = 0;

    const connector = context.chargePoint.getConnector(connectorId);

    const parseNumber = (v: any): number | null => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const cleaned = v.replace(/[^0-9.\-]/g, '');
        if (cleaned.length === 0) return null;
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      }
      return null;
    };

    const interval = setInterval(async () => {
      checkCount++;

      if (isStopped) {
        clearInterval(interval);
        return;
      }

      // If the connector no longer has an active transaction, stop monitoring
      const currentConnector = context.chargePoint.getConnector(connectorId);
      if (!currentConnector || !currentConnector.transaction) {
        isStopped = true;
        clearInterval(interval);
        if (currentConnector) {
          currentConnector.monitoringIntervalId = null;
        }
        context.logger.info(`🛑 Monitoring stopped - no active transaction on connector ${connectorId}`, LogType.TRANSACTION);
        return;
      }

      try {
        const apiUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${transactionId}`;
        context.logger.info(`[Check #${checkCount}] Fetching: ${apiUrl}`, LogType.TRANSACTION);

        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          mode: 'cors'
        });

        context.logger.info(`[Check #${checkCount}] HTTP ${response.status}`, LogType.TRANSACTION);

        if (!response.ok) {
          const errorText = await response.text();
          context.logger.error(`[Check #${checkCount}] API ERROR ${response.status}: ${errorText.substring(0, 100)}`, LogType.TRANSACTION);
          return;
        }

        const data = await response.json();

        if (!data || typeof data !== 'object') {
          context.logger.warn(`[Check #${checkCount}] Invalid response structure`, LogType.TRANSACTION);
          return;
        }

        // Check for locked_amount — do not use any default until this is present
        let apiLocked = data.locked_amount ?? data.lockAmount ?? data.lockamount ?? data.lock_amount;
        apiLocked = parseNumber(apiLocked);

        if (typeof apiLocked !== 'number') {
          context.logger.info(`[Check #${checkCount}] No locked_amount yet from API for tx ${transactionId}; still waiting (connector remains in current state)` , LogType.TRANSACTION);
          return; // keep waiting
        }

        // Apply locked amount from API once available
        if (!currentConnector.lockSetByApi || currentConnector.lockAmount !== apiLocked) {
          currentConnector.lockAmount = apiLocked;
          currentConnector.lockSetByApi = true;
          context.logger.info(`💰 Applied connector ${connectorId} lockAmount from API: ₹${apiLocked}`, LogType.TRANSACTION);
        }

        // Parse revenue robustly
        let currentRevenue = parseNumber(data.revenue_amount ?? data.revenue);
        const apiStatus = data.status;

        if (currentRevenue === null) {
          context.logger.warn(`[Check #${checkCount}] Invalid revenue_amount: ${String(data.revenue_amount ?? data.revenue)} — will retry`, LogType.TRANSACTION);
          return;
        }

        const effectiveLock = currentConnector.lockAmount;
        context.logger.info(`[Check #${checkCount}] Revenue: ₹${currentRevenue} (Limit: ₹${effectiveLock}) | API Status: ${apiStatus}`, LogType.TRANSACTION);

        // Update connector status based on API
        const prevStatus = currentConnector.status;
        if (typeof apiStatus === 'string') {
          const s = apiStatus.toUpperCase();
          if (s === 'LIVE' || s === 'CHARGING') currentConnector.status = OCPPStatus.Charging;
          else if (s === 'PREPARING' || s === 'PENDING') currentConnector.status = OCPPStatus.Preparing;
          else currentConnector.status = OCPPStatus.Available;
        }
        if (currentConnector.status !== prevStatus) {
          context.logger.info(`⚡ Status changed to ${currentConnector.status} on connector ${connectorId} after API response`, LogType.TRANSACTION);
        }

        // Stop monitoring if status is not LIVE (charging stopped on backend)
        if (apiStatus !== 'LIVE') {
          context.logger.info(`🛑 Charging not LIVE (status=${apiStatus}) - stopping monitoring for tx ${transactionId}`, LogType.TRANSACTION);
          isStopped = true;
          clearInterval(interval);
          if (currentConnector) currentConnector.monitoringIntervalId = null;
          return;
        }

        // CRITICAL: If revenue >= lock amount, STOP THIS CONNECTOR ONLY
        if (currentRevenue >= effectiveLock) {
          context.logger.error(`💥 CHARGING LIMIT REACHED on connector ${connectorId}! ₹${currentRevenue} >= ₹${effectiveLock}`, LogType.TRANSACTION);

          isStopped = true;
          clearInterval(interval);
          if (currentConnector) currentConnector.monitoringIntervalId = null;

          // Trigger auto-stop for THIS connector only
          if (currentConnector && currentConnector.transaction) {
            context.logger.error(`🛑 AUTO-STOP INITIATED for transaction ${transactionId} on connector ${connectorId}`, LogType.TRANSACTION);
            context.chargePoint.stopTransaction(currentConnector);
            context.logger.info(`✅ AUTO-STOP COMPLETE for transaction ${transactionId} on connector ${connectorId}`, LogType.TRANSACTION);
          }
          return;
        } else {
          const remaining = (effectiveLock - currentRevenue).toFixed(2);
          context.logger.debug(`[Check #${checkCount}] Connector ${connectorId} remaining: ₹${remaining}`, LogType.TRANSACTION);
        }

      } catch (error) {
        context.logger.error(`[Check #${checkCount}] Connector ${connectorId} exception: ${error instanceof Error ? error.message : String(error)}`, LogType.TRANSACTION);
      }
    }, 5000); // Check every 5 seconds

    // Store interval on the connector for proper per-connector cleanup
    if (connector) {
      connector.monitoringIntervalId = interval;
    }

    context.logger.info(`✅ Monitoring started for connector ${connectorId} - checks every 5 seconds`, LogType.TRANSACTION);
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
      `Transaction stopped successfully on connector ${this.connectorId}: ${JSON.stringify(payload)}`,
      LogType.TRANSACTION,
    );
    const connector = context.chargePoint.getConnector(this.connectorId);
    if (!connector) return;

    // Clear cost monitoring interval if still running
    connector.clearMonitoringInterval();

    // ChargePoint.stopTransaction() already handles cleanup and status update.
    // Only do cleanup here if the connector still has a lingering transaction
    // (defensive handling for edge cases).
    if (connector.transaction) {
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
