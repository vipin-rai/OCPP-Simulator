 import {
  OcppMessageErrorPayload,
  OcppMessagePayload,
  OcppMessageRequestPayload,
  OcppMessageResponsePayload,
  OCPPWebSocket,
} from "./OCPPWebSocket";
import { ChargePoint } from "./ChargePoint";
import { Logger } from "./Logger";
import {
  BootNotification,
  OCPPAction,
  OcppConfigurationKey,
  OCPPErrorCode,
  OCPPMessageType,
  OCPPStatus,
} from "./OcppTypes";
import { UploadFile } from "./file_upload.ts";
import {
  ArrayConfigurationValue,
  BooleanConfigurationValue,
  Configuration,
  ConfigurationValue,
  defaultConfiguration,
  IntegerConfigurationValue,
  StringConfigurationValue,
} from "./Configuration.ts";

import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

// ✅ FIXED: Separate types for INCOMING CALLS (CSMS -> Charger)
type IncomingCallPayload =
  | request.ChangeAvailabilityRequest
  | request.ChangeConfigurationRequest
  | request.ClearCacheRequest
  | request.GetConfigurationRequest
  | request.RemoteStartTransactionRequest
  | request.RemoteStopTransactionRequest
  | request.ResetRequest
  | request.UnlockConnectorRequest
  | request.DataTransferRequest  // ✅ Added properly
  | request.GetDiagnosticsRequest
  | request.UpdateFirmwareRequest
  | request.GetLocalListVersionRequest
  | request.SendLocalListRequest
  | request.CancelReservationRequest
  | request.ReserveNowRequest
  | request.ClearChargingProfileRequest
  | request.GetCompositeScheduleRequest
  | request.SetChargingProfileRequest
  | request.TriggerMessageRequest;

type OutgoingCallResultPayload =  // Charger -> CSMS responses
  | response.AuthorizeResponse
  | response.BootNotificationResponse
  | response.ChangeConfigurationResponse
  | response.DataTransferResponse
  | response.HeartbeatResponse
  | response.MeterValuesResponse
  | response.StartTransactionResponse
  | response.StatusNotificationResponse
  | response.StopTransactionResponse;

interface OCPPRequest {
  type: OCPPMessageType;
  action: OCPPAction;
  id: string;
  payload: OcppMessagePayload;
  connectorId?: number | null;
}

class RequestHistory {
  private _currentId: string = "";
  private _requests: Map<string, OCPPRequest> = new Map();

  public add(request: OCPPRequest): void {
    this._currentId = request.id;
    this._requests.set(request.id, request);
  }

  public current(): OCPPRequest | undefined {
    return this._requests.get(this._currentId);
  }

  public get(id: string): OCPPRequest | undefined {
    return this._requests.get(id);
  }

  public remove(id: string): void {
    this._requests.delete(id);
  }
}

export interface Transaction {
  id?: number;
  tagId: string;
  meterStart: number;
  meterStop?: number;
  startTime: Date;
  stopTime?: Date;
  estimatedCost?: number;
  chargeBoxId?: number;
}

export class OCPPMessageHandler {
  private monitoringTransactions: Set<number> = new Set();
  private monitoringIntervals: Map<number, NodeJS.Timeout> = new Map(); // Store intervals to clear on stop
  private preparingTimeouts: Map<number, NodeJS.Timeout> = new Map(); // Store Preparing timeouts to cancel if needed
  private _chargePoint: ChargePoint;
  private _webSocket: OCPPWebSocket;
  private _logger: Logger;
  private _requests: RequestHistory = new RequestHistory();

  constructor(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger
  ) {
    this._chargePoint = chargePoint;
    this._webSocket = webSocket;
    this._logger = logger;

    this._webSocket.setMessageHandler(this.handleIncomingMessage.bind(this));
  }

  // ===================== PUBLIC FUNCTIONS (OUTGOING) =====================
  public authorize(tagId: string): void {
    const messageId = this.generateMessageId();
    const payload: request.AuthorizeRequest = { idTag: tagId };
    this.sendRequest(OCPPAction.Authorize, messageId, payload);
  }

  public startTransaction(transaction: Transaction, connectorId: number): void {
    const messageId = this.generateMessageId();
    const payload: request.StartTransactionRequest = {
      connectorId,
      idTag: transaction.tagId,
      meterStart: transaction.meterStart,
      timestamp: transaction.startTime.toISOString(),
    };
    this.sendRequest(OCPPAction.StartTransaction, messageId, payload, connectorId);
  }

  public stopTransaction(transaction: Transaction, connectorId: number): void {
    const connector = this._chargePoint.getConnector(connectorId);
    
    // ✅ SET STATUS TO FINISHING
    if (connector) {
      connector.status = OCPPStatus.Finishing;
      this.sendStatusNotification(connectorId, OCPPStatus.Finishing);
      this._logger.info(`⏹️ Status changed to FINISHING on connector ${connectorId}`);
      console.log(`⏹️ Status: FINISHING (stopping transaction...)`);
    }
    
    const messageId = this.generateMessageId();
    const payload: request.StopTransactionRequest = {
      transactionId: transaction.id!,
      idTag: transaction.tagId,
      meterStop: transaction.meterStop!,
      timestamp: transaction.stopTime!.toISOString(),
    };
    
    // ✅ STOP MONITORING when charging ends
    if (transaction.id && this.monitoringIntervals.has(transaction.id)) {
      const interval = this.monitoringIntervals.get(transaction.id);
      if (interval) clearInterval(interval);
      this.monitoringIntervals.delete(transaction.id);
      console.log(`🛑 Monitoring stopped for tx ${transaction.id}`);
      this._logger.info(`🛑 Monitoring stopped for transaction ${transaction.id}`);
    }

    // ✅ CLEAR PREPARING TIMEOUT if still pending
    if (this.preparingTimeouts.has(connectorId)) {
      const timeoutId = this.preparingTimeouts.get(connectorId);
      if (timeoutId) clearTimeout(timeoutId);
      this.preparingTimeouts.delete(connectorId);
      this._logger.info(`⏹️ Cleared Preparing timeout for connector ${connectorId}`);
    }

    this.sendRequest(OCPPAction.StopTransaction, messageId, payload, connectorId);
  }

  public sendBootNotification(bootPayload: BootNotification): void {
    const messageId = this.generateMessageId();
    const payload: request.BootNotificationRequest = {
      chargePointVendor: bootPayload.ChargePointVendor,
      chargePointModel: bootPayload.ChargePointModel,
      chargePointSerialNumber: bootPayload.ChargePointSerialNumber,
      chargeBoxSerialNumber: bootPayload.ChargeBoxSerialNumber,
      firmwareVersion: bootPayload.FirmwareVersion,
      iccid: bootPayload.Iccid,
      imsi: bootPayload.Imsi,
      meterType: bootPayload.MeterType,
      meterSerialNumber: bootPayload.MeterSerialNumber,
    };
    this.sendRequest(OCPPAction.BootNotification, messageId, payload);
  }

  public sendHeartbeat(): void {
    const messageId = this.generateMessageId();
    const payload: request.HeartbeatRequest = {};
    this.sendRequest(OCPPAction.Heartbeat, messageId, payload);
  }

  public sendMeterValue(transactionId: number | undefined, connectorId: number, meterValue: number): void {
  // 🔥 AUTO MONITORING START - REMOVE (monitoring starts from handleStartTransactionResponse instead)
  // This old code is disabled because lockAmount should come from handleStartTransactionResponse
  /*
  if (transactionId && !this.monitoringTransactions.has(transactionId)) {
    console.log(`🎯 LIVE TX ${transactionId} DETECTED! Auto monitoring START...`);
    this.startCostMonitoring(connectorId, transactionId);
    this.monitoringTransactions.add(transactionId);
  }
  */
  
  // Original code (unchanged)
  const messageId = this.generateMessageId();
  const payload: request.MeterValuesRequest = {
    transactionId,
    connectorId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: meterValue.toString() }],
      },
    ],
  };
  this.sendRequest(OCPPAction.MeterValues, messageId, payload);
}

  public sendStatusNotification(connectorId: number, status: OCPPStatus): void {
    const messageId = this.generateMessageId();
    const payload: request.StatusNotificationRequest = {
      connectorId,
      errorCode: "NoError",
      status,
    };
    this.sendRequest(OCPPAction.StatusNotification, messageId, payload);
  }

  // ✅ FIXED: DataTransfer outgoing (TransactionAmount to CSMS)
  public sendDataTransfer(transaction: Transaction, connectorId: number) {
    const messageId = this.generateMessageId();
    const payload: request.DataTransferRequest = {
      vendorId: "RB",  // Your vendor ID
      messageId: "TransactionAmount",
      data: JSON.stringify({
        estimatedCost: transaction.estimatedCost || 0,
        connectorId,
        chargeBoxId: transaction.chargeBoxId || 0,
      }),
    };
    this.sendRequest(OCPPAction.DataTransfer, messageId, payload, connectorId);
  }

  // Public helper for sending StartTransaction OCPP message
  // Status transitions are handled by handleRemoteStartTransaction
  public initiateStartTransaction(transaction: Transaction, connectorId: number): void {
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector) {
      this._logger.error(`Cannot initiate start: connector ${connectorId} not found`);
      return;
    }

    // ✅ Just send the StartTransaction OCPP message
    // Status is already set to Charging by handleRemoteStartTransaction's 5-second timeout
    this.startTransaction(transaction, connectorId);
  }

  // ===================== PRIVATE: SEND REQUEST =====================
  private sendRequest(
    action: OCPPAction,
    id: string,
    payload: OcppMessageRequestPayload,
    connectorId?: number
  ): void {
    this._requests.add({ type: OCPPMessageType.CALL, action, id, payload, connectorId });
    this._webSocket.sendAction(id, action, payload);
  }

  // ===================== MAIN HANDLER =====================
  private handleIncomingMessage(
    messageType: OCPPMessageType,
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayload
  ): void {
    this._logger.log(`Handling incoming: ${messageType}, ${messageId}, ${action}`);

    switch (messageType) {
      case OCPPMessageType.CALL:
        this.handleCall(messageId, action, payload as IncomingCallPayload);  // ✅ Fixed type
        break;
      case OCPPMessageType.CALL_RESULT:
        this.handleCallResult(messageId, payload as OutgoingCallResultPayload);
        break;
      case OCPPMessageType.CALL_ERROR:
        this.handleCallError(messageId, payload as OcppMessageErrorPayload);
        break;
      default:
        this._logger.error(`Unknown message type: ${messageType}`);
    }
  }

  // ✅ FIXED: Proper Incoming CALL handling
  private handleCall(messageId: string, action: OCPPAction, payload: IncomingCallPayload): void {
    let response: OcppMessageResponsePayload;

    switch (action) {
      case OCPPAction.DataTransfer:
        response = this.handleIncomingDataTransfer(payload as request.DataTransferRequest);  // ✅ Now works
        break;
      case OCPPAction.RemoteStartTransaction:
        response = this.handleRemoteStartTransaction(payload as request.RemoteStartTransactionRequest);
        break;
      case OCPPAction.RemoteStopTransaction:
        response = this.handleRemoteStopTransaction(payload as request.RemoteStopTransactionRequest);
        break;
      case OCPPAction.Reset:
        response = this.handleReset(payload as request.ResetRequest);
        break;
      case OCPPAction.GetDiagnostics:
        response = this.handleGetDiagnostics(payload as request.GetDiagnosticsRequest);
        break;
      case OCPPAction.TriggerMessage:
        response = this.handleTriggerMessage(payload as request.TriggerMessageRequest);
        break;
      case OCPPAction.GetConfiguration:
        response = this.handleGetConfiguration(payload as request.GetConfigurationRequest);
        break;
      case OCPPAction.ChangeConfiguration:
        response = this.handleChangeConfiguration(payload as request.ChangeConfigurationRequest);
        break;
      case OCPPAction.ClearCache:
        response = this.handleClearCache(payload as request.ClearCacheRequest);
        break;
      case OCPPAction.UnlockConnector:
        response = this.handleUnlockConnector(payload as request.UnlockConnectorRequest);
        break;
      default:
        this._logger.error(`Unsupported action: ${action}`);
        this.sendCallError(messageId, "NotImplemented", `Action ${action} not supported`);
        return;
    }

    this.sendCallResult(messageId, response);
  }

  // ✅ FIXED: Incoming DataTransfer from CSMS (vendorId=27, msgId=8)
  private handleIncomingDataTransfer(payload: request.DataTransferRequest): response.DataTransferResponse {
    this._logger.log(`Incoming DataTransfer: vendorId=${payload.vendorId}, msgId=${payload.messageId}, data=${payload.data}`);
    
    // Handle your vendor commands
    if (payload.vendorId === "27" && payload.messageId === "8") {
      try {
        // Parse "TransactionAmount:10.0" or JSON
        const dataMatch = payload.data?.match(/TransactionAmount:([\d.]+)/);
        if (dataMatch) {
          const amount = parseFloat(dataMatch[1]);
          this._logger.log(`Updated transaction amount: ${amount}`);
          // NOTE: Per requirements, do NOT use DataTransfer to set lock amounts.
          // The transaction API must be the single source of truth for `locked_amount`.
          // We accept the TransactionAmount payload for informational purposes only.
          this._logger.info(`Received TransactionAmount via DataTransfer (ignored for lock): ₹${amount}`);
          return { status: "Accepted" };
        }
      } catch (e) {
        this._logger.error(`DataTransfer parse error: ${e}`);
        return { status: "Rejected" };
      }
    }
    
    return { status: "UnknownVendorId" };
  }

  // ===================== OTHER HANDLERS (unchanged but working) =====================
  private handleCallResult(messageId: string, payload: OutgoingCallResultPayload): void {
    const request = this._requests.get(messageId);
    if (!request) {
      this._logger.log(`Unexpected CallResult: ${messageId}`);
      return;
    }

    // Resolve connectorId: prefer stored request.connectorId, fall back to
    // searching connectors by transactionId present in the payload (if any).
    let resolvedConnectorId: number | undefined = request.connectorId ?? undefined;
    if (!resolvedConnectorId) {
      const maybeTxId = (payload as any)?.transactionId as number | undefined;
      if (maybeTxId) {
        const found = Array.from(this._chargePoint.connectors.values()).find(
          c => c.transaction?.id === maybeTxId || c.transactionId === maybeTxId
        );
        if (found) resolvedConnectorId = found.id;
      }
    }

    switch (request.action) {
      case OCPPAction.StartTransaction:
        if (resolvedConnectorId === undefined) {
          this._logger.error(`StartTransaction response received but connectorId could not be resolved for message ${messageId}`);
        } else {
          // fire-and-forget async handler
          void this.handleStartTransactionResponse(resolvedConnectorId, payload as response.StartTransactionResponse);
        }
        break;
      case OCPPAction.StopTransaction:
        if (resolvedConnectorId === undefined) {
          this._logger.error(`StopTransaction response received but connectorId could not be resolved for message ${messageId}`);
        } else {
          this.handleStopTransactionResponse(resolvedConnectorId, payload as response.StopTransactionResponse);
        }
        break;
      case OCPPAction.DataTransfer:
        this.handleDataTransferResponse(payload as response.DataTransferResponse);
        break;
      default:
        this._logger.log(`Result for ${request.action}`);
    }

    this._requests.remove(messageId);
  }

  private handleCallError(messageId: string, error: OcppMessageErrorPayload): void {
    this._logger.error(`CallError ${messageId}: ${JSON.stringify(error)}`);
    this._requests.remove(messageId);
  }

  private handleRemoteStartTransaction(payload: request.RemoteStartTransactionRequest): response.RemoteStartTransactionResponse {
    const connectorId = payload.connectorId || 1;
    const connector = this._chargePoint.getConnector(connectorId);
    const startTime = Date.now();
    console.log("🔥 🔥 🔥 handleRemoteStartTransaction CALLED!");
    console.log(`[RemoteStart] Time: ${startTime}, connectorId=${connectorId}, idTag=${payload.idTag}`);
    
    if (!connector || connector.availability !== "Operative") {
      console.error(`[RemoteStart] REJECTED - connector unavailable`);
      return { status: "Rejected" };
    }
    
    // ✅ STEP 1: Create transaction object IMMEDIATELY (but don't send OCPP message yet)
    console.log(`[RemoteStart] Creating transaction object for connector ${connectorId}`);
    const transaction: Transaction = {
      id: 0,
      connectorId: connectorId,
      tagId: payload.idTag,
      meterStart: 0,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    };
    connector.transaction = transaction;
    console.log(`[RemoteStart] Transaction object created and assigned to connector`);
    
    // ✅ STEP 2: Immediately set status to PREPARING and send notification
    console.log(`[RemoteStart] Setting connector status to PREPARING`);
    connector.status = OCPPStatus.Preparing;
    this.sendStatusNotification(connectorId, OCPPStatus.Preparing);
    this._logger.info(`🔌 Connector ${connectorId} status set to PREPARING`);
    console.log(`🔌 PREPARING: Waiting 5 seconds...`);
    
    // ✅ STEP 3: After 5 seconds, change status to CHARGING, then send StartTransaction OCPP message
    console.log(`[RemoteStart] Setting 5-second timeout...`);
    
    const timeoutId = setTimeout(() => {
      const elapsedMs = Date.now() - startTime;
      console.log(`\n⏰⏰⏰ [5SEC TIMEOUT FIRED] After ${elapsedMs}ms for connector ${connectorId} ⏰⏰⏰\n`);
      
      this.preparingTimeouts.delete(connectorId);
      
      const freshConnector = this._chargePoint.getConnector(connectorId);
      if (!freshConnector || !freshConnector.transaction) {
        console.error(`[Timeout] ERROR: Connector or transaction not found!`);
        return;
      }
      
      if (freshConnector.availability !== "Operative") {
        console.log(`[Timeout] Connector became unavailable - aborting`);
        return;
      }
      
      console.log(`[Timeout] Setting status to CHARGING`);
      freshConnector.status = OCPPStatus.Charging;
      this.sendStatusNotification(connectorId, OCPPStatus.Charging);
      this._logger.info(`⚡ Status changed to CHARGING on connector ${connectorId}`);
      console.log(`⚡ Status is now: CHARGING`);
      
      // NOW send the StartTransaction OCPP message
      console.log(`[Timeout] Sending StartTransaction OCPP message`);
      this.startTransaction(freshConnector.transaction as Transaction, connectorId);
      console.log(`[Timeout] StartTransaction OCPP message sent\n`);
      
    }, 5000);
    
    this.preparingTimeouts.set(connectorId, timeoutId);
    console.log(`[RemoteStart] Timeout stored, returning Accepted\n`);
    
    return { status: "Accepted" };
  }

  private handleRemoteStopTransaction(payload: request.RemoteStopTransactionRequest): response.RemoteStopTransactionResponse {
    const connector = Array.from(this._chargePoint.connectors.values()).find(c => c.transaction?.id === payload.transactionId);
    if (connector) {
      // ✅ If still in Preparing state, cancel the timeout
      if (this.preparingTimeouts.has(connector.id)) {
        const timeoutId = this.preparingTimeouts.get(connector.id);
        if (timeoutId) clearTimeout(timeoutId);
        this.preparingTimeouts.delete(connector.id);
        console.log(`⏹️ Canceled Preparing timeout for connector ${connector.id}`);
        this._logger.info(`⏹️ Canceled Preparing timeout for connector ${connector.id}`);
      }
      
      this._chargePoint.stopTransaction(connector);
      return { status: "Accepted" };
    }
    return { status: "Rejected" };
  }

  private handleReset(payload: request.ResetRequest): response.ResetResponse {
    setTimeout(() => {
      if (payload.type === "Hard") this._chargePoint.reset();
      else this._chargePoint.boot();
    }, 5000);
    return { status: "Accepted" };
  }

  private handleGetDiagnostics(payload: request.GetDiagnosticsRequest): response.GetDiagnosticsResponse {
    const logs = this._logger.getLogs().join("\n");
    const blob = new Blob([logs], { type: "text/plain" });
    const file = new File([blob], "diagnostics.txt");
    (async () => await UploadFile(payload.location, file))();
    return { fileName: "diagnostics.txt" };
  }

  private handleGetConfiguration(payload: request.GetConfigurationRequest): response.GetConfigurationResponse {
    const configuration = OCPPMessageHandler.mapConfiguration(defaultConfiguration(this._chargePoint));
    if (!payload.key || payload.key.length === 0) return { configurationKey: configuration };
    const filteredConfig = configuration.filter(c => payload.key?.includes(c.key));
    const configurationKeys = configuration.map(c => c.key);
    const unknownKeys = payload.key!.filter(c => !configurationKeys.includes(c));
    return { configurationKey: filteredConfig, unknownKey: unknownKeys };
  }

  private handleChangeConfiguration(_payload: request.ChangeConfigurationRequest): response.ChangeConfigurationResponse {
    return { status: "NotSupported" };
  }

  private handleTriggerMessage(_payload: request.TriggerMessageRequest): response.TriggerMessageResponse {
    return { status: "Accepted" };
  }

  private handleClearCache(_payload: request.ClearCacheRequest): response.ClearCacheResponse {
    return { status: "Accepted" };
  }

  private handleUnlockConnector(_payload: request.UnlockConnectorRequest): response.UnlockConnectorResponse {
    return { status: "NotSupported" };
  }

  private handleDataTransferResponse(payload: response.DataTransferResponse): void {
    this._logger.log(`DataTransfer response: ${JSON.stringify(payload)}`);
  }

 private async handleStartTransactionResponse(connectorId: number, payload: response.StartTransactionResponse): Promise<void> {
  console.log(`[StartTransactionResponse] txID=${payload.transactionId}, idTagStatus=${payload.idTagInfo?.status}`);
  this._logger.info(`StartTransaction response: txID=${payload.transactionId}, status=${payload.idTagInfo?.status}`);

  const connector = this._chargePoint.getConnector(connectorId);
  if (!connector) {
    this._logger.error(`Connector ${connectorId} not found - cannot start monitoring`);
    console.error(`[StartTransactionResponse] Connector ${connectorId} not found`);
    return;
  }

  if (payload.idTagInfo?.status === "Accepted") {
    connector.transactionId = payload.transactionId;

    // Status is already set to Charging by initiateStartTransaction's 5-second timeout
    // Do NOT change status here - just start monitoring
    this._logger.info(`✅ StartTransaction accepted for tx ${payload.transactionId} on connector ${connectorId}`);
    this._logger.info(`💰 Starting cost monitoring for txID=${payload.transactionId}, connectorID=${connectorId}`);
    console.log(`[StartTransactionResponse] Transaction accepted - status is: ${connector.status}, starting monitoring...`);
    
    // ✅ UPDATE BACKEND DATABASE STATUS TO "LIVE"
    await this.updateTransactionStatusToLive(payload.transactionId, connectorId);
    
    // Start monitoring (no status change needed - already Charging from the 5s timeout)
    this.startCostMonitoring(connectorId, payload.transactionId);
  } else {
    this._logger.error(`Transaction REJECTED: ${payload.idTagInfo?.status}`);
    connector.status = OCPPStatus.Available;
    this.sendStatusNotification(connectorId, OCPPStatus.Available);
    this._logger.info(`🔌 Status reverted to AVAILABLE (transaction rejected)`);
    console.log(`[StartTransactionResponse] Transaction rejected - status reverted to Available`);
  }
}

  // ✅ UPDATE BACKEND DATABASE TO "LIVE" STATUS WHEN TRANSACTION ACCEPTED
  private async updateTransactionStatusToLive(transactionId: number, connectorId: number): Promise<void> {
    const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';
    const updateUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${transactionId}/status`;
    
    try {
      console.log(`[UpdateStatus] Making API call to update transaction ${transactionId} to LIVE status`);
      this._logger.info(`🔄 Updating backend database: transaction ${transactionId} status to LIVE`);
      
      const response = await fetch(updateUrl, {
        method: 'PUT',
        headers: { 
          'Accept': 'application/json', 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 'LIVE',
          connector_id: connectorId,
          timestamp: new Date().toISOString()
        }),
        mode: 'cors'
      });

      if (response.ok) {
        console.log(`[UpdateStatus] ✅ Backend database updated - transaction ${transactionId} status set to LIVE`);
        this._logger.info(`✅ Backend database updated - transaction ${transactionId} is now LIVE`);
      } else {
        const errorText = await response.text();
        console.warn(`[UpdateStatus] ⚠️ Update response ${response.status}: ${errorText.substring(0, 100)}`);
        this._logger.warn(`Backend status update returned ${response.status}: ${errorText.substring(0, 100)}`);
      }
    } catch (error) {
      console.error(`[UpdateStatus] ❌ Error updating transaction status:`, error);
      this._logger.error(`Error updating transaction status to LIVE: ${error}`);
      // Don't let this error block the monitoring - continue anyway
    }
  }

  private startCostMonitoring(connectorId: number, transactionId: number, _initialLockAmount?: number): void {
  this._logger.info(`=== COST MONITORING SESSION START ===`);
  this._logger.info(`Transaction: ${transactionId} | Connector: ${connectorId}`);

  const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';

  let isStopped = false;
  let checkCount = 0;

  const interval = setInterval(async () => {
    checkCount++;

    if (isStopped) {
      clearInterval(interval);
      return;
    }

    // If the connector no longer has an active transaction, stop monitoring
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector || !connector.transaction) {
      isStopped = true;
      clearInterval(interval);
      this.monitoringIntervals.delete(transactionId);
      this._logger.info(`🛑 Monitoring stopped - no active transaction on connector ${connectorId}`);
      return;
    }

    try {
      const apiUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${transactionId}`;
      this._logger.info(`[Check #${checkCount}] Fetching: ${apiUrl}`);

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        mode: 'cors'
      });

      this._logger.info(`[Check #${checkCount}] HTTP ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this._logger.error(`[Check #${checkCount}] API ERROR ${response.status}: ${errorText.substring(0, 100)}`);
        return;
      }

      const data = await response.json();

      if (!data || typeof data !== 'object') {
        this._logger.warn(`[Check #${checkCount}] Invalid response structure`);
        return;
      }

      // Update connector lock amount if API provides one (keeps monitoring limit accurate)
      const apiLockedRaw2 = data.locked_amount ?? data.lockAmount ?? data.lockamount ?? data.lock_amount;
      const apiLocked2 = this.parseNumber(apiLockedRaw2);

      if (typeof apiLocked2 !== 'number') {
        // No lock amount provided yet by API — keep waiting and do not apply any default.
        this._logger.info(`[Check #${checkCount}] No locked_amount yet from API for tx ${transactionId}; still waiting (connector remains PREPARING)`);
        return;
      }

  
      if (apiLocked2 !== connector.lockAmount) {
        connector.lockAmount = apiLocked2;
        // Mark that the lock was sourced from the authoritative transaction API
        (connector as any).lockSetByApi = true;
        this._logger.info(`💰 Applied connector ${connectorId} lockAmount from API: ₹${apiLocked2}`);
      }

      // NOW that we have a locked_amount, apply it to the connector
      // Status is already Charging from the 5-second timeout in initiateStartTransaction
      if (connector.status === OCPPStatus.Preparing) {
        // This shouldn't happen now, but keep as safety net
        connector.status = OCPPStatus.Charging;
        this.sendStatusNotification(connectorId, OCPPStatus.Charging);
        this._logger.info(`⚡ Status changed to CHARGING on connector ${connectorId}`);
      }

      // Parse revenue for limit checking (may not be available on first check)
      let currentRevenue: number | null = null;
      if (data.revenue_amount !== undefined) currentRevenue = this.parseNumber(data.revenue_amount);
      if ((currentRevenue === null || isNaN(currentRevenue)) && data.revenue !== undefined) currentRevenue = this.parseNumber(data.revenue);

      const apiStatus = data.status;

      if (currentRevenue === null || isNaN(currentRevenue)) {
        this._logger.warn(`[Check #${checkCount}] No valid revenue_amount yet (${String(data.revenue_amount ?? data.revenue)}) — will retry`);
        // Continue monitoring even if revenue is not yet available
        return;
      }

      // Stop monitoring if status is not LIVE (charging stopped on backend)
      if (apiStatus !== "LIVE") {
        this._logger.info(`🛑 Charging not LIVE (status=${apiStatus}) - stopping monitoring for tx ${transactionId}`);
        isStopped = true;
        clearInterval(interval);
        this.monitoringIntervals.delete(transactionId);
        return;
      }

      const effectiveLock = connector.lockAmount as number;
      this._logger.info(`[Check #${checkCount}] Revenue: ₹${currentRevenue} (Limit: ₹${effectiveLock}) | API Status: ${apiStatus}`);

      // CRITICAL: If revenue >= lock amount, STOP THIS CONNECTOR ONLY
      if (currentRevenue >= effectiveLock) {
        this._logger.error(`💥 CHARGING LIMIT REACHED on connector ${connectorId}! ₹${currentRevenue} >= ₹${effectiveLock}`);

        isStopped = true;
        clearInterval(interval);
        this.monitoringIntervals.delete(transactionId);

        await this.triggerAutoStop(transactionId, connectorId, currentRevenue, effectiveLock);
        return;
      } else {
        const remaining = (effectiveLock - currentRevenue).toFixed(2);
        this._logger.debug(`[Check #${checkCount}] Connector ${connectorId} remaining: ₹${remaining}`);
      }

    } catch (error) {
      this._logger.error(`[Check #${checkCount}] Connector ${connectorId} exception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 5000); // Check every 5 seconds

  // Store interval so we can clear it on stopTransaction
  this.monitoringIntervals.set(transactionId, interval);
  this.monitoringTransactions.add(transactionId);

  this._logger.info(`✅ Monitoring started for connector ${connectorId} - checks every 5 seconds`);
}

  private async triggerAutoStop(transactionId: number, connectorId: number, currentRevenue: number, lockAmount: number): Promise<void> {
  this._logger.error(`🛑 AUTO-STOP INITIATED for transaction ${transactionId} on connector ${connectorId}`);

  try {
    // Use the connector's actual transaction if available, otherwise create a fallback
    const connector = this._chargePoint.getConnector(connectorId);
    if (connector && connector.transaction) {
      this._logger.info(`🚫 Stopping transaction ${transactionId} on connector ${connectorId}`);
      this._chargePoint.stopTransaction(connector);
    } else {
      // Fallback: create a minimal transaction for the StopTransaction message
      const transaction: Transaction = {
        id: transactionId,
        tagId: 'AUTO_STOP',
        meterStart: 0,
        meterStop: Math.floor(currentRevenue * 1000),
        startTime: new Date(Date.now() - 600000),
        stopTime: new Date(),
        chargeBoxId: parseInt(this._chargePoint.id) || 131315
      };
      this.stopTransaction(transaction, connectorId);
    }

    this._logger.info(`✅ AUTO-STOP COMPLETE for transaction ${transactionId} on connector ${connectorId}`);
  } catch (error) {
    this._logger.error(`❌ AUTO-STOP ERROR on connector ${connectorId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}




  private handleStopTransactionResponse(connectorId: number, _payload: response.StopTransactionResponse): void {
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector) return;

    // Clear Preparing timeout if still active
    if (this.preparingTimeouts.has(connectorId)) {
      const timeoutId = this.preparingTimeouts.get(connectorId);
      if (timeoutId) clearTimeout(timeoutId);
      this.preparingTimeouts.delete(connectorId);
    }

    // Clear cost monitoring for THIS connector's transaction only
    if (connector.transaction?.id) {
      const txId = connector.transaction.id;
      if (this.monitoringIntervals.has(txId)) {
        const interval = this.monitoringIntervals.get(txId);
        if (interval) clearInterval(interval);
        this.monitoringIntervals.delete(txId);
        this.monitoringTransactions.delete(txId);
      }
    }

    connector.transaction = null;
    connector.transactionId = null;
    connector.status = OCPPStatus.Available;

    this.sendStatusNotification(connectorId, OCPPStatus.Available);
    this._logger.info(`✅ Status changed to AVAILABLE on connector ${connectorId}`);
  }

  // ===================== UTILS =====================
  private sendCallResult(messageId: string, payload: OcppMessageResponsePayload): void {
    this._webSocket.sendResult(messageId, payload);
  }

  private sendCallError(messageId: string, errorCode: OCPPErrorCode, errorDescription: string): void {
    this._webSocket.sendError(messageId, { errorCode, errorDescription });
  }

  private generateMessageId(): string {
    return crypto.randomUUID();
  }

  private static mapConfiguration(config: Configuration): OcppConfigurationKey[] {
    return config.map(c => ({
      key: c.key.name,
      readonly: c.key.readonly,
      value: OCPPMessageHandler.mapValue(c),
    }));
  }

  private static mapValue(value: ConfigurationValue): string {
    switch (value.key.type) {
      case "string": return (value as StringConfigurationValue).value;
      case "boolean": return String((value as BooleanConfigurationValue).value);
      case "integer": return String((value as IntegerConfigurationValue).value);
      case "array": return (value as ArrayConfigurationValue).value.join(",");
      default: return "";
    }
  }

  // Parse numbers from API fields robustly (accept numbers, numeric strings, or strings with currency)
  private parseNumber(value: any): number | null {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      // Remove non-numeric characters except dot and minus
      const cleaned = value.replace(/[^0-9.\-]/g, "");
      if (cleaned.length === 0) return null;
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    return null;
  }
}  