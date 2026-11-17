// Opens a match sealed by the server's draw (see drawAndSeal in src/api.js).
// The 256-bit key only ever exists locked to the member's own devices (see below).
// Format: base64( iv[12] || AES-256-GCM ciphertext+tag ), AAD = "match:<slotId>".

export async function openSealedMatch(sealedB64, keyBytes, slotId) {
  const raw = Uint8Array.from(atob(sealedB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(`match:${slotId}`) },
    key,
    raw.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------------------------------------------------------------------------
// Portal reveal: unwrap the match key with this browser's private device key.
// ---------------------------------------------------------------------------

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder();
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export const wrapInfo = (slotId, deviceId) => `pwag-match-key:v1:${slotId}:${deviceId}`;

/** A new device key pair. The private key is NOT extractable: it can never leave this browser. */
export async function generateDeviceKey() {
  const pair = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

export async function unwrapMatchKey(privateKey, { epk, wrapped }, slotId, deviceId) {
  const ephPub = await crypto.subtle.importKey('raw', unb64(epk), CURVE, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = te.encode(wrapInfo(slotId, deviceId));
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const raw = unb64(wrapped);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: info }, aes, raw.slice(12)));
}
