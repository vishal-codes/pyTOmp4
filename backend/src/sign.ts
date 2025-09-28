// HMAC signing for asset URLs: sig = HMAC_SHA256( key + "\n" + exp )
// exp is a unix timestamp (seconds). We use base64url for the signature.


// --- base64url helpers ---
function b64url(buf: ArrayBuffer | Uint8Array) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToBytes(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- HMAC helpers ---
async function importKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signKey(secret: string, key: string, expSec: number) {
  // expSec = UNIX seconds
  const data = new TextEncoder().encode(`${key}|${expSec}`);
  const k = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", k, data);
  return b64url(sig);
}

export async function verifySig(secret: string, key: string, expSec: number, sigB64u: string) {
  // reject if expired (tolerate small clock drift if you want)
  if (!expSec || Date.now() > expSec * 1000) return false;

  const k = await importKey(secret);
  const data = new TextEncoder().encode(`${key}|${expSec}`);
  const sig = b64urlToBytes(sigB64u);

  // crypto.subtle.verify does constant-time comparison for us
  return crypto.subtle.verify("HMAC", k, sig, data);
}
