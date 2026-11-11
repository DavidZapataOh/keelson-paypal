import { del, get, post } from "./api";

/**
 * Where this browser stands on phone approvals: unsupported, an iPhone that must add Keelson to
 * its Home Screen first (iOS 16.4+), blocked by the user, or on or off.
 */
export type PushState = "unsupported" | "install" | "denied" | "on" | "off";

const ios = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function registerWorker(): Promise<ServiceWorkerRegistration> | undefined {
  if (!("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return ios() && !matchMedia("(display-mode: standalone)").matches ? "install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

/** Asks for permission, subscribes with Keelson's VAPID key and stores the subscription. */
export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const registration =
    (await navigator.serviceWorker.getRegistration("/")) ?? (await registerWorker());
  if (!registration) return "unsupported";
  await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>("/v1/push/key");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });
  await post("/v1/push/subscriptions", subscription.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await del("/v1/push/subscriptions", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  return "off";
}
