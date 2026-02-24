import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

export class DataTransferHandler
  implements CallHandler<request.DataTransferRequest, response.DataTransferResponse>
{
  handle(
    payload: request.DataTransferRequest,
    context: HandlerContext,
  ): response.DataTransferResponse {
    context.logger.info(
      `DataTransfer request received: vendorId=${payload.vendorId}, messageId=${payload.messageId}, data=${payload.data}`,
      LogType.OCPP,
    );

    // Example: vendorId "27" and messageId "8" -> TransactionAmount:10.0
    if (payload.vendorId === "27") {
      if (payload.messageId === "8") {
        try {
          const dataMatch = payload.data?.match(/TransactionAmount:([\d.]+)/);
          if (dataMatch) {
            const amount = parseFloat(dataMatch[1]);
            context.logger.info(`Updated transaction amount: ${amount}`, LogType.OCPP);
            // Persist amount to ALL connectors (may be called before/during/after transaction)
            // Don't check status - just store it so it's available when transaction starts
            for (const c of Array.from(context.chargePoint.connectors.values())) {
              (c as any).lockAmount = amount;
              context.logger.info(`✅ Saved lockAmount=₹${amount} to connector ${c.id}`, LogType.OCPP);
            }
            return { status: "Accepted" };
          }

          // Try JSON parse as fallback
          if (payload.data) {
            const parsed = JSON.parse(payload.data);
            if (parsed && parsed.TransactionAmount) {
              context.logger.info(`Updated transaction amount: ${parsed.TransactionAmount}`, LogType.OCPP);
              return { status: "Accepted" };
            }
          }
        } catch (e) {
          context.logger.error(`DataTransfer parse error: ${e}`, LogType.OCPP);
          return { status: "Rejected" };
        }
        // If messageId 8 but payload unrecognized
        return { status: "UnknownMessageId" };
      }
      // Vendor recognized but message id not handled
      return { status: "UnknownMessageId" };
    }

    // Unknown vendor
    return { status: "UnknownVendorId" };
  }
}
