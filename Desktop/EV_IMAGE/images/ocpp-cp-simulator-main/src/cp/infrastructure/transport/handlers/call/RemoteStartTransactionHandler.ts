import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import type { Transaction } from "../../../../domain/connector/Transaction";

export class RemoteStartTransactionHandler
  implements
    CallHandler<
      request.RemoteStartTransactionRequest,
      response.RemoteStartTransactionResponse
    >
{
  private preparingTimeouts: Map<number, NodeJS.Timeout> = new Map();

  handle(
    payload: request.RemoteStartTransactionRequest,
    context: HandlerContext,
  ): response.RemoteStartTransactionResponse {
    const { idTag, connectorId } = payload;
    const connector = context.chargePoint.getConnector(connectorId || 1);
    const actualConnectorId = connectorId || 1;
    const startTime = Date.now();

    console.log("🔥 🔥 🔥 RemoteStartTransactionHandler.handle CALLED!");
    console.log(`[RemoteStart] Time: ${startTime}, connectorId=${actualConnectorId}, idTag=${idTag}`);

    if (!connector || connector.availability !== "Operative") {
      console.error(`[RemoteStart] REJECTED - connector unavailable`);
      return { status: "Rejected" };
    }

    // ✅ STEP 1: Create transaction object IMMEDIATELY
    console.log(`[RemoteStart] Creating transaction object for connector ${actualConnectorId}`);
    const transaction: Transaction = {
      id: 0,
      connectorId: actualConnectorId,
      tagId: idTag,
      meterStart: 0,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    };
    connector.transaction = transaction;
    // ✅ Setup auto meter value increments
    connector.beginTransaction(transaction);
    console.log(`[RemoteStart] Transaction object created and meter values configured`);

    // ✅ STEP 2: Immediately set status to PREPARING and send notification
    console.log(`[RemoteStart] Setting connector status to PREPARING`);
    context.chargePoint.updateConnectorStatus(actualConnectorId, OCPPStatus.Preparing);
    context.logger.info(`🔌 Connector ${actualConnectorId} status set to PREPARING`);
    console.log(`🔌 PREPARING: Waiting 5 seconds...`);

    // ✅ STEP 3: After 5 seconds, change status to CHARGING, then send StartTransaction OCPP message
    console.log(`[RemoteStart] Setting 5-second timeout...`);

    const timeoutId = setTimeout(() => {
      const elapsedMs = Date.now() - startTime;
      console.log(`\n⏰⏰⏰ [5SEC TIMEOUT FIRED] After ${elapsedMs}ms for connector ${actualConnectorId} ⏰⏰⏰\n`);

      this.preparingTimeouts.delete(actualConnectorId);

      const freshConnector = context.chargePoint.getConnector(actualConnectorId);
      if (!freshConnector || !freshConnector.transaction) {
        console.error(`[Timeout] ERROR: Connector or transaction not found!`);
        return;
      }

      if (freshConnector.availability !== "Operative") {
        console.log(`[Timeout] Connector became unavailable - aborting`);
        return;
      }

      console.log(`[Timeout] Setting status to CHARGING`);
      context.chargePoint.updateConnectorStatus(actualConnectorId, OCPPStatus.Charging);
      context.logger.info(`⚡ Status changed to CHARGING on connector ${actualConnectorId}`);
      console.log(`⚡ Status is now: CHARGING`);

      // NOW send the StartTransaction OCPP message
      console.log(`[Timeout] Sending StartTransaction OCPP message`);
      context.chargePoint.messageHandler.startTransaction(
        freshConnector.transaction as Transaction,
        actualConnectorId
      );
      console.log(`[Timeout] StartTransaction OCPP message sent\n`);
    }, 5000);

    this.preparingTimeouts.set(actualConnectorId, timeoutId);
    console.log(`[RemoteStart] Timeout stored, returning Accepted\n`);

    return { status: "Accepted" };
  }
}
