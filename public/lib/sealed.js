// Opens a match sealed by the server's draw (see drawAndSeal in src/api.js).
// The 256-bit key only ever lives in the member's email link and on their device.
// Format: base64( iv[12] || AES-256-GCM ciphertext+tag ), AAD = "match:<slotId>".

export function decodeKey(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('Invalid key');
  return bytes;
}

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
