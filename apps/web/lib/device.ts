const KEY = "keelson.device";

/** This browser's opaque device id, sent as `Keelson-Device` when compiling a mandate. */
export function deviceId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
