export type TTSOut = { bytes: Uint8Array; contentType: string; ext: "mp3" | "wav" };

export async function synthesizeLine(env: any, rawText: string): Promise<TTSOut> {
  const text = String(rawText || "").slice(0, 300) || " ";

  // Try MeloTTS first (expects { prompt, lang })
  try {
    if (env.AI && env.AI_MODEL_TTS?.includes("melotts")) {
      const res: any = await env.AI.run(env.AI_MODEL_TTS, { prompt: text, lang: "en" });
      const b64 = typeof res?.audio === "string" ? res.audio : (typeof res === "string" ? res : null);
      if (!b64) throw new Error("No 'audio' in MeloTTS response");
      return { bytes: base64ToBytes(b64), contentType: "audio/mpeg", ext: "mp3" };
    }
  } catch (e) {
    console.warn("MeloTTS failed, will try fallbacks:", (e as Error).message);
  }

  // Fallbacks for other TTS models you may test later
  try {
    const res: any = await env.AI.run(env.AI_MODEL_TTS, { text });
    if (res instanceof ArrayBuffer) return { bytes: new Uint8Array(res), contentType: "audio/wav", ext: "wav" };
    if (res?.audio instanceof ArrayBuffer) return { bytes: new Uint8Array(res.audio), contentType: "audio/wav", ext: "wav" };
    if (typeof res?.audio === "string") return { bytes: base64ToBytes(res.audio), contentType: "audio/mpeg", ext: "mp3" };
  } catch {}

  // Final fallback: short silent WAV so pipeline keeps working locally
  return { bytes: makeSilentWav(secondsFromText(text)), contentType: "audio/wav", ext: "wav" };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function secondsFromText(t: string): number {
  const words = t.trim().split(/\s+/).filter(Boolean).length || 1;
  return Math.max(0.9, Math.min(6, words * 0.4));
}

function makeSilentWav(seconds: number, sampleRate = 22050): Uint8Array {
  const frames = Math.floor(seconds * sampleRate);
  const bytesPerSample = 2;
  const dataSize = frames * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF"); view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE"); writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true); view.setUint16(34, 16, true);
  writeAscii(view, 36, "data"); view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}
function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
