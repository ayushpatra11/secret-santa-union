// Server side of the portal reveal: wrap a one-time match key to a device's public
// key (ECIES over P-256). The matching unwrap lives in public/lib/sealed.js and runs
// only in the member's browser, which holds the non-extractable private key.

const te = new TextEncoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

export const wrapInfo = (slotId, deviceId) => `pwag-match-key:v1:${slotId}:${deviceId}`;

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/** Validate a device public key (base64 raw uncompressed P-256 point). Throws if invalid. */
export async function importDevicePublicKey(publicKeyB64) {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64.length > 200) throw new Error('bad key');
  const raw = unb64(publicKeyB64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad key');
  return crypto.subtle.importKey('raw', raw, CURVE, false, []);
}

/** Wrap `keyBytes` so that only the holder of the device's private key can recover it. */
export async function wrapForDevice(publicKeyB64, keyBytes, slotId, deviceId) {
  const devicePub = await importDevicePublicKey(publicKeyB64);
  const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: devicePub }, eph.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = te.encode(wrapInfo(slotId, deviceId));
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: info }, aes, keyBytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return { epk: b64(await crypto.subtle.exportKey('raw', eph.publicKey)), wrapped: b64(out) };
}
