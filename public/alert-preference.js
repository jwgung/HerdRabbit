const STORAGE_KEY = "herd-rabbit:alert-sound";

// On unless turned off; storage that cannot be read leaves it on.
export function readAlertSound(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAlertSound(storage, enabled) {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {}
}
