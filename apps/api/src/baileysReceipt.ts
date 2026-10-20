type DeliveryStatus = "SENT" | "DELIVERED" | "READ" | "PLAYED";

const deliveryRank: Record<DeliveryStatus, number> = { SENT: 1, DELIVERED: 2, READ: 3, PLAYED: 4 };

export function baileysDeliveryStatus(update: any): Exclude<DeliveryStatus, "SENT"> | null {
  const receipt = update?.receipt || update?.update || {};
  const statusValue = update?.update?.status ?? update?.status;
  const statusText = String(statusValue || "").toUpperCase();
  const statusNumber = Number(statusValue);
  if (receipt.playedTimestamp || statusNumber >= 5 || statusText.includes("PLAYED")) return "PLAYED";
  if (receipt.readTimestamp || statusNumber >= 4 || statusText.includes("READ")) return "READ";
  if (receipt.receiptTimestamp || statusNumber >= 3 || statusText.includes("DELIVERY_ACK") || statusText.includes("DELIVERED")) return "DELIVERED";
  return null;
}

export function isDeliveryStatusAdvance(current: string | null, next: Exclude<DeliveryStatus, "SENT">) {
  const currentRank = current && Object.prototype.hasOwnProperty.call(deliveryRank, current) ? deliveryRank[current as DeliveryStatus] : 0;
  return deliveryRank[next] > currentRank;
}
