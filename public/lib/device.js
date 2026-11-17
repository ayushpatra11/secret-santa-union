// This browser's device key for the portal reveal. The private key is generated
// non-extractable and kept in IndexedDB, so it can be used here but never read out.

import { generateDeviceKey } from './sealed.js';

const DB_NAME = 'pwag';
const STORE = 'device';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** Device stored for this account in this browser, or null. Keyed per account. */
export async function loadDevice(accountKey) {
  try {
    return (await tx('readonly', (s) => s.get(accountKey))) || null;
  } catch {
    return null;
  }
}

/**
 * Make sure this browser has a device key registered for the signed-in account.
 * `known` is the list of device ids the server has for the account.
 * Returns the device, or null if this browser can't store keys (e.g. private mode).
 */
export async function ensureDevice(accountKey, known, register) {
  const existing = await loadDevice(accountKey);
  if (existing && known.includes(existing.id)) return existing;
  try {
    const key = await generateDeviceKey();
    const { deviceId } = await register(key.publicKey);
    const device = { id: deviceId, privateKey: key.privateKey };
    await tx('readwrite', (s) => s.put(device, accountKey));
    return device;
  } catch {
    return null;
  }
}
