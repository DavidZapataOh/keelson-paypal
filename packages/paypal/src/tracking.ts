import type { PayPalFetch } from "./rest.ts";
import { type ShippingTracker, trackerList } from "./schemas/tracking.ts";

export interface TrackerRef {
  captureId: string;
  trackingNumber: string;
  /** A PayPal carrier code, as on the Orders v2 tracker. */
  carrier: string;
}

/**
 * The trackers of a capture as the Add Tracking API reports them. Unlike the Orders v2 tracker,
 * whose status is only `SHIPPED` or `CANCELLED`, these carry `DELIVERED`.
 */
export async function listTrackers(f: PayPalFetch, captureId: string): Promise<ShippingTracker[]> {
  const res = await f<unknown>("GET", "/v1/shipping/trackers", {
    query: { transaction_id: captureId },
  });
  return trackerList.parse(res).trackers;
}

/** Records that the shipment of a tracker added for the capture was delivered. */
export async function markDelivered(f: PayPalFetch, t: TrackerRef): Promise<void> {
  await f<void>(
    "PUT",
    `/v1/shipping/trackers/${encodeURIComponent(`${t.captureId}-${t.trackingNumber}`)}`,
    {
      body: {
        transaction_id: t.captureId,
        tracking_number: t.trackingNumber,
        carrier: t.carrier,
        status: "DELIVERED",
      },
    },
  );
}
