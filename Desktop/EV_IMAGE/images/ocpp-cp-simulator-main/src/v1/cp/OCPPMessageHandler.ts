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
          // Save amount to ALL connectors (may be called before/during/after transaction)
          // Don't check status - just store it so it's available when transaction starts
          for (const c of Array.from(this._chargePoint.connectors.values())) {
            (c as any).lockAmount = amount;
            this._logger.info(`✅ Saved lockAmount=₹${amount} to connector ${c.id}`);
          }
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

    switch (request.action) {
      case OCPPAction.StartTransaction:
        this.handleStartTransactionResponse(request.connectorId || 1, payload as response.StartTransactionResponse);
        break;
      case OCPPAction.StopTransaction:
        this.handleStopTransactionResponse(request.connectorId || 1, payload as response.StopTransactionResponse);
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
     console.log("🔥 🔥 🔥 handleRemoteStartTransaction CALLED! vipivvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvpddddddddddddviffd");
    
    if (!connector || connector.availability !== "Operative") {
      return { status: "Rejected" };
    }
    
    // ✅ STEP 1: Immediately set status to PREPARING
    connector.status = OCPPStatus.Preparing;
    this.sendStatusNotification(connectorId, OCPPStatus.Preparing);
    this._logger.info(`🔌 Connector ${connectorId} status set to PREPARING`);
    console.log(`🔌 PREPARING: Waiting 5 seconds for EV connection simulation...`);
    
    // ✅ STEP 2: After 5 seconds, transition to CHARGING (notify backend) then send StartTransaction
    const timeoutId = setTimeout(() => {
      // Clean up
      this.preparingTimeouts.delete(connectorId);

      if (connector.availability !== "Operative") {
        console.log(`❌ Connector became unavailable - canceling charging`);
        this._logger.info(`❌ Connector ${connectorId} became unavailable during Preparing`);
        return;
      }

      console.log(`✅ 5 seconds elapsed - Transitioning to CHARGING and sending StartTransaction...`);
      this._logger.info(`✅ 5 seconds elapsed - Transitioning to CHARGING for connector ${connectorId}`);

      // Set status to CHARGING and notify backend BEFORE sending StartTransaction CALL
      connector.status = OCPPStatus.Charging;
      this.sendStatusNotification(connectorId, OCPPStatus.Charging);
      this._logger.info(`⚡ Status notification sent: CHARGING on connector ${connectorId}`);
      console.log(`⚡ Status changed to: CHARGING`);

      // Now send StartTransaction CALL to CSMS (backend also watches this CALL)
      this._chargePoint.startTransaction(payload.idTag, connectorId);

      // StartTransaction response handler will attach transactionId and start monitoring
    }, 5000);

    // Store timeout so we can cancel it if RemoteStop is called during Preparing
    this.preparingTimeouts.set(connectorId, timeoutId);

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

 private handleStartTransactionResponse(connectorId: number, payload: response.StartTransactionResponse): void {
  console.log("🚀 START TRANSACTION RESPONSE CALLED!");
  console.log("Payload:", JSON.stringify(payload, null, 2));
  this._logger.info(`StartTransaction response: txID=${payload.transactionId}, status=${payload.idTagInfo?.status}`);
  
  const connector = this._chargePoint.getConnector(connectorId);
  if (!connector) {
    console.log("❌ Connector not found!");
    this._logger.error(`Connector ${connectorId} not found - cannot start monitoring`);
    return;
  }
  
  console.log("✅ Connector found:", connectorId);
  
  if (payload.idTagInfo?.status === "Accepted") {
    console.log("✅ STATUS ACCEPTED! Transaction ID:", payload.transactionId);
    connector.transactionId = payload.transactionId;
    connector.status = OCPPStatus.Charging;
    
    // ✅ SEND STATUS NOTIFICATION: CHARGING
    this.sendStatusNotification(connectorId, OCPPStatus.Charging);
    this._logger.info(`⚡ Status notification sent: CHARGING on connector ${connectorId}`);
    console.log(`⚡ Status changed to: CHARGING`);
    
    // Lock amount: prefer connector value (from DataTransfer), else default ₹5
    let lockAmount = (connector as any).lockAmount || 5.0;
    console.log("💰 Lock Amount Set:", lockAmount);
    this._logger.info(`💰 Lock Amount: ₹${lockAmount} for transaction ${payload.transactionId}`);
    console.log("🔥 Starting cost monitoring...");
    this._logger.info(`🔥 Starting cost monitoring for txID=${payload.transactionId}, connectorID=${connectorId}, lockAmount=₹${lockAmount}`);
    this.startCostMonitoring(connectorId, payload.transactionId, lockAmount);
    
    // Async: Try to fetch locked_amount from API in background (don't block)
    (async () => {
      try {
        const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';
        const apiUrl = `${EXTERNAL_BASE}/api/app/vehicles/transaction/${payload.transactionId}`;
        const resp = await fetch(apiUrl, { method: 'GET', headers: { 'Accept': 'application/json' }, mode: 'cors' });
        if (resp.ok) {
          const data = await resp.json();
          let apiLocked = data.locked_amount ?? data.lockAmount ?? data.lockamount ?? data.lock_amount;
          if (typeof apiLocked === 'string') apiLocked = parseFloat(apiLocked as string);
          if (typeof apiLocked === 'number' && !isNaN(apiLocked) && apiLocked !== lockAmount) {
            (connector as any).lockAmount = apiLocked;
            console.log(`💰 Updated lock amount from API to: ${apiLocked}`);
            this._logger.info(`💰 Updated lock amount from API to: ₹${apiLocked}`);
          }
        }
      } catch (e) {
        // Silently fail - monitoring already started with default/DataTransfer amount
      }
    })();
  } else {
    console.log("❌ Status NOT Accepted:", payload.idTagInfo?.status);
    this._logger.error(`Transaction REJECTED: ${payload.idTagInfo?.status}`);
    
    // ❌ If rejected, revert status back to Available
    connector.status = OCPPStatus.Available;
    this.sendStatusNotification(connectorId, OCPPStatus.Available);
    this._logger.info(`🔌 Status reverted to AVAILABLE (transaction rejected)`);
  }
}

  private startCostMonitoring(connectorId: number, transactionId: number, lockAmount: number): void {
  console.log(`🎯 COST MONITORING STARTED: TxID=${transactionId}, ConnID=${connectorId}, LockAmount=₹${lockAmount}`);
  console.log(`📱 Browser hostname: ${typeof window !== 'undefined' ? window.location.hostname : 'N/A'}`);
  this._logger.info(`=== COST MONITORING SESSION START ===`);
  this._logger.info(`Transaction: ${transactionId} | Connector: ${connectorId} | Lock Limit: ₹${lockAmount}`);

  const EXTERNAL_BASE = 'http://192.168.1.44:8099/RB';
  const runningLocally = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  console.log(`🔍 Running locally? ${runningLocally}`);
  
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
      const apiPath = `/api/app/vehicles/transaction/${transactionId}`;
      const apiUrl = runningLocally ? apiPath : `${EXTERNAL_BASE}${apiPath}`;
      console.log(`🌐 FETCHING: ${apiUrl}`);
      console.log(`   📍 TransactionID: ${transactionId}, ConnectorID: ${connectorId}, LockAmount: ₹${lockAmount}`);
      this._logger.info(`[Check #${checkCount}] API Call - TxID=${transactionId}, Conn=${connectorId}, Lock=₹${lockAmount}`);
      this._logger.info(`[Check #${checkCount}] Fetching from: ${apiUrl}`);

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        mode: 'cors'
      });

      console.log(`📡 Response status: ${response.status} ${response.statusText}`);
      this._logger.info(`[Check #${checkCount}] HTTP ${response.status}`);

      if (!response.ok) {
        console.error(`❌ API ERROR: ${response.status} ${response.statusText}`);
        const errorText = await response.text();
        console.error('Error body:', errorText.substring(0, 200));
        this._logger.error(`[Check #${checkCount}] API ERROR ${response.status}: ${errorText.substring(0, 100)}`);
        return;
      }

      const data = await response.json();
      console.log(`📊 API RESPONSE:`, JSON.stringify(data, null, 2));

      // Validate API response structure
      if (!data || typeof data !== 'object') {
        console.warn('⚠️ Invalid API response structure - expected object');
        this._logger.warn(`[Check #${checkCount}] Invalid response structure`);
        return;
      }

      const currentRevenue = data.revenue_amount;
      const apiStatus = data.status;

      if (typeof currentRevenue !== 'number' || currentRevenue === null || currentRevenue === undefined) {
        console.warn(`⚠️ Missing or invalid revenue_amount in response:`, data);
        this._logger.warn(`[Check #${checkCount}] Invalid revenue_amount: ${currentRevenue}`);
        return;
      }

      // ✅ CRITICAL: Stop monitoring if status is not LIVE (charging stopped on backend)
      if (apiStatus !== "LIVE") {
        console.log(`🛑 API Status is NOT LIVE (${apiStatus}) - STOPPING MONITORING`);
        this._logger.info(`🛑 Charging stopped on backend (status=${apiStatus}) - stopping monitoring for tx ${transactionId}`);
        isStopped = true;
        clearInterval(interval);
        this.monitoringIntervals.delete(transactionId);
        return;
      }

      console.log(`💵 REVENUE CHECK: ₹${currentRevenue} / Lock: ₹${lockAmount} | Status: ${apiStatus}`);
      console.log(`   ✓ currentRevenue=${currentRevenue} (type: ${typeof currentRevenue})`);
      console.log(`   ✓ lockAmount=${lockAmount} (type: ${typeof lockAmount})`);
      console.log(`   ✓ Comparison: ${currentRevenue} >= ${lockAmount} = ${currentRevenue >= lockAmount}`);
      this._logger.info(`[Check #${checkCount}] Revenue: ₹${currentRevenue} (Limit: ₹${lockAmount}) | API Status: ${apiStatus}`);

      // CRITICAL: If revenue >= lock amount, STOP IMMEDIATELY
      if (currentRevenue >= lockAmount) {
        console.log(`💰💥 ⚡ LIMIT REACHED! Revenue ₹${currentRevenue} >= Lock ₹${lockAmount} - STOPPING NOW!`);
        this._logger.error(`💥 CHARGING LIMIT REACHED! ₹${currentRevenue} >= ₹${lockAmount}`);
        
        isStopped = true;
        clearInterval(interval);
        this.monitoringIntervals.delete(transactionId); // Remove from tracking
        this._logger.info(`🛑 Cleared monitoring interval - preparing auto-stop`);
        
        await this.triggerAutoStop(transactionId, connectorId, currentRevenue, lockAmount);
        return;
      } else {
        const remaining = (lockAmount - currentRevenue).toFixed(2);
        console.log(`⏳ Continuing... Remaining: ₹${remaining}`);
        this._logger.debug(`[Check #${checkCount}] Remaining: ₹${remaining}`);
      }

    } catch (error) {
      console.error(`💥 FETCH ERROR:`, error);
      this._logger.error(`[Check #${checkCount}] Exception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 10000); // Check every 10 seconds exactly

  // Store interval so we can clear it on stopTransaction
  this.monitoringIntervals.set(transactionId, interval);
  this.monitoringTransactions.add(transactionId);

  console.log(`✅ Monitoring started | Interval: 10 seconds`);
  this._logger.info(`✅ Monitoring started - checks every 10 seconds`);
}

  private async triggerAutoStop(transactionId: number, connectorId: number, currentRevenue: number, lockAmount: number): Promise<void> {
  console.log(`🛑 AUTO-STOP TRIGGERED: TxID=${transactionId}, Revenue=₹${currentRevenue}, Lock=₹${lockAmount}`);
  this._logger.error(`🛑 AUTO-STOP INITIATED for transaction ${transactionId}`);

  try {
    const transaction: Transaction = {
      id: transactionId,
      tagId: 'AUTO_STOP',
      meterStart: 0,
      meterStop: Math.floor(currentRevenue * 1000), // Mock meter value
      startTime: new Date(Date.now() - 600000),
      stopTime: new Date(),
      chargeBoxId: parseInt(this._chargePoint.id) || 131315
    };

    console.log(`🚫 Calling stopTransaction with:`, JSON.stringify(transaction, null, 2));
    this._logger.info(`🚫 Sending StopTransaction: txID=${transactionId}, connID=${connectorId}`);
    
    this.stopTransaction(transaction, connectorId);

    console.log(`✅ AUTO-STOP COMPLETE! Transaction ${transactionId} stopped.`);
    this._logger.error(`✅ AUTO-STOP COMPLETE! Charging stopped for transaction ${transactionId}`);
  } catch (error) {
    console.error(`❌ AUTO-STOP FAILED:`, error);
    this._logger.error(`❌ AUTO-STOP ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}




  private handleStopTransactionResponse(connectorId: number, _payload: response.StopTransactionResponse): void {
    const connector = this._chargePoint.getConnector(connectorId);
    if (connector) {
      connector.transaction = null;
      connector.transactionId = null;
      connector.status = OCPPStatus.Available;
      
      // ✅ SEND STATUS NOTIFICATION: AVAILABLE
      this.sendStatusNotification(connectorId, OCPPStatus.Available);
      this._logger.info(`✅ Status changed to AVAILABLE on connector ${connectorId}`);
      console.log(`✅ Status: AVAILABLE (Transaction stopped)`);
    }
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
}  