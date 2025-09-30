/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { runDetect, runEvents, runNarration, runComplexity, runSync } from "./ai/client";
import { validateEventTrace, validateNarration, validateComplexity } from "./validate";
import { buildDetectPrompt, buildEventsPrompt, buildNarrationPrompt, buildComplexityPrompt, buildSyncPrompt } from "./ai/prompts";
import { specJSON } from "./spec/templates";
import { runPrep } from "./prep";
import { putJSON, putBytes } from "./r2";
import { synthesizeLine } from "./tts";
import { createDirectUpload } from "./stream";
import { verifySig, signKey } from "./sign";

export interface Env {
  pyTOmp4_d1: D1Database;
  prep_queue: Queue<any>;
  py_to_mp4_render: Queue<any>;
  pytomp4_r2: R2Bucket;

  AI: any;
  AI_MODEL_DETECT: string;
  AI_MODEL_EVENTS: string;
  AI_MODEL_NARRATION: string;
  AI_MODEL_TTS: string;

  STREAM_API_TOKEN: string;
  STREAM_ACCOUNT_ID: string;

  PUBLIC_BASE_URL: string;
  ASSET_SIGNING_KEY: string;
  CALLBACK_TOKEN: string;
}

type JobStatus = "queued" | "prepping" | "ready_to_render" | "rendering" | "done" | "failed";
// types you already have / expect
type TTSOut = { bytes: Uint8Array; contentType: string; ext: string };

// tiny helper (drop next to your PREP code)
function normalizeTTS(out: TTSOut | Uint8Array): TTSOut {
  if (out instanceof Uint8Array) {
    return { bytes: out, contentType: "audio/wav", ext: "wav" };
  }
  // assume well-formed TTSOut
  return out;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function normalizeNarrLine(s: string) {
  return String(s)
    .replace(/:/g, " — ")
    .replace(/\s+/g, " ")
    .replace(/\s*([,;!?])\s*/g, "$1 ")    // keep commas/semicolons spacing
    .replace(/\s+\./g, ".")               // no space before periods
    .replace(/\.{2,}/g, ".")              // collapse multi-dots
    .replace(/\s+$/,"")
    .replace(/([^.?!])$/,"$1.");          // ensure sentence end
}

function buildSceneLinesSmart(events: any, nums?: number[], target?: number) {
  const scenes: any[] = Array.isArray(events?.scenes)
    ? events.scenes
    : (Array.isArray(events) ? events : []);

  const getVal = (i?: number) =>
    (Number.isInteger(i) && nums && nums[i!] != null) ? nums[i!] : undefined;

  const lines: string[] = [];
  let lastL: number|undefined, lastM: number|undefined, lastR: number|undefined;

  for (const s of scenes) {
    const t = (s.t || s.type || "").toLowerCase();

    if (t === "titlecard") {
      lines.push(
        (typeof target === "number")
        ? `Let us solve rotated binary search for target ${target}.`
        : `Let us solve rotated binary search.`
      );
      continue;
    }

    if (t === "arraytape") {
      const l = s.left ?? s.pointers?.left;
      const m = s.mid  ?? s.pointers?.mid;
      const r = s.right?? s.pointers?.right;
      const mv = getVal(m), lv = getVal(l), rv = getVal(r);
      let base = `We examine the window from index ${l} to ${r}, midpoint ${m}`;
      if (typeof mv === "number") base += ` with value ${mv}`;
      if (typeof target === "number") base += ` while searching for ${target}`;
      lines.push(base + ".");
      lastL=l; lastM=m; lastR=r;
      continue;
    }

    if (t === "callout") {
      // Keep your AI text if present, but make it natural
      const txt = (s.text || "Observe this property").toString()
        .replace(/:/g," — ");
      lines.push(txt.endsWith(".") ? txt : `${txt}.`);
      continue;
    }

    if (t === "movepointer") {
      const which = s.which || "left";
      const to = s.to;
      // Explain WHY based on target vs mid
      const m = lastM; const mv = getVal(m);
      let why = "";
      if (typeof target === "number" && typeof mv === "number") {
        if (which === "left") {
          why = (target > mv)
            ? "because the target is greater than mid."
            : "because the target is not in the left half.";
        } else if (which === "right") {
          why = (target < mv)
            ? "because the target is smaller than mid."
            : "to narrow the right boundary.";
        }
      }
      lines.push(`Move ${which} pointer to index ${to} ${why}`.trim().replace(/\s+\./,".") + ".");
      if (which === "left") lastL = to;
      if (which === "right") lastR = to;
      continue;
    }

    if (t === "complexitycard") {
      const tc = s.time || s.time_complexity || "O(log n)";
      const sc = s.space || s.space_complexity || "O(1)";
      lines.push(`This halves the search space, time ${tc} and space ${sc}.`);
      continue;
    }

    if (t === "resultcard") {
      // Prefer explicit target/value mention
      if (typeof target === "number") {
        const v = getVal(s.index ?? lastM ?? lastL ?? lastR);
        const idx = s.index ?? lastM ?? lastL ?? lastR;
        lines.push(`Answer: found target ${target} at index ${idx}.`);
      } else {
        lines.push(`Answer: found at index ${s.index ?? lastM ?? lastL ?? lastR}.`);
      }
      continue;
    }

    // default
    lines.push("Proceed to the next step.");
  }

  // TTS-safe normalization
  return lines.map(normalizeNarrLine);
}


// ---------- Helpers: TTS synth → R2 ----------
async function ttsPerScene(env: Env, jobId: string, lines: string[]) {
  // Makes audio/000.mp3, 001.mp3, ...
  // NOTE: melotts expects { prompt: string }, returns audio bytes (wav-like).
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] || " ";
    try {
      const audio = await env.AI.run(env.AI_MODEL_TTS as any, {
        prompt: text,
        // You can pass optional voice params if supported by the model:
        // voice: "female", emotion: "narration", ...
      });
      const key = `jobs/${jobId}/audio/${String(i).padStart(3, "0")}.mp3`;
      await env.pytomp4_r2.put(key, audio as ArrayBuffer, {
        httpMetadata: { contentType: "audio/mpeg" }, // ffmpeg will read it regardless
      });
    } catch (e) {
      // Fallback: generate 1s of silence so renderer timing still works
      const silence = makeOneSecondSilenceWav();
      const key = `jobs/${jobId}/audio/${String(i).padStart(3, "0")}.mp3`;
      await env.pytomp4_r2.put(key, silence, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: { note: "tts-fallback" },
      });
    }
  }
}

// Tiny 1s PCM silence (WAV header + 44100 mono samples @ s16le)
// We'll just reuse with .mp3 extension; ffmpeg will sniff content fine.
function makeOneSecondSilenceWav(): ArrayBuffer {
  const sr = 44100;
  const bytesPerSample = 2;
  const dataLen = sr * bytesPerSample;
  const totalLen = 44 + dataLen;
  const buf = new ArrayBuffer(totalLen);
  const v = new DataView(buf);
  function W(i: number, s: string) {
    for (let k = 0; k < s.length; k++) v.setUint8(i + k, s.charCodeAt(k));
  }
  // RIFF header
  W(0, "RIFF");
  v.setUint32(4, totalLen - 8, true);
  W(8, "WAVE");
  // fmt
  W(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * bytesPerSample, true);
  v.setUint16(32, bytesPerSample, true);
  v.setUint16(34, 16, true); // bits
  // data
  W(36, "data");
  v.setUint32(40, dataLen, true);
  // samples already zeroed (silence)
  return buf;
}


async function insertJob(DB: D1Database, row: {
  id: string; created_at: number; updated_at: number; status: JobStatus;
  language: string; leetcode_id: string | null; algo: string | null;
  playback_url: string | null; stream_uid: string | null; message: string | null;
}) {
  await DB.prepare(
    `INSERT INTO jobs (id, created_at, updated_at, status, language, leetcode_id, algo, playback_url, stream_uid, message)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
  ).bind(
    row.id, row.created_at, row.updated_at, row.status, row.language,
    row.leetcode_id, row.algo, row.playback_url, row.stream_uid, row.message
  ).run();
}

async function updateJob(DB: D1Database, id: string, patch: Partial<{
  status: JobStatus; message: string | null; algo: string | null;
  playback_url: string | null; stream_uid: string | null;
}>) {
  const fields = Object.keys(patch);
  if(!fields.length) return;
  const sets = fields.map((k, i) => `${k} = ?${i + 1}`).join(", ");
  const vals = fields.map((k) => (patch as any)[k]);
  const sql = `UPDATE jobs SET ${sets}, updated_at = ?${fields.length + 1} WHERE id = ?${fields.length + 2}`;
  await DB.prepare(sql).bind(...vals, nowSec(), id).run();
}

async function getJob(DB: D1Database, id: string) {
  const r = await DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(id).first();
  return r ?? null;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// keep it seconds-based and only use `key`
function makeSignedUrl(env: Env, key: string, ttlSec = 60 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec; // seconds
  const base = env.PUBLIC_BASE_URL; // no trailing slash
  return signKey(env.ASSET_SIGNING_KEY, key, exp).then(sig =>
    `${base}/assets/get?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/assets/get") {
    const url = new URL(req.url);
    const rawKey = url.searchParams.get("key") ?? "";
    const key = decodeURIComponent(rawKey);
    const exp = Number(url.searchParams.get("exp") ?? "0"); // seconds
    const sig = url.searchParams.get("sig") ?? "";

    if (!key || !Number.isFinite(exp) || !sig) return json({ error: "missing params" }, 400);

    const ok = await verifySig(env.ASSET_SIGNING_KEY, key, exp, sig); // exp is seconds
    if (!ok) return json({ error: "bad or expired signature" }, 403);

    const obj = await env.pytomp4_r2.get(key);
    if (!obj) return json({ error: "not found", key }, 404);

    const headers = {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=60",
    };

    return req.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(obj.body, { headers });
  }
    
  if (req.method === "GET" && pathname === "/debug/r2/list") {
    const prefix = new URL(req.url).searchParams.get("prefix") ?? "";
    const list = await env.pytomp4_r2.list({ prefix });
    return json(list.objects.map(o => o.key));
  }
  
  if (req.method === "GET" && pathname === "/debug/r2/get") {
    const u = new URL(req.url);
    const key = (u.searchParams.get("key") || "").replace(/^\/+/, "");
    const obj = await env.pytomp4_r2.get(key);
    if (!obj) return new Response(JSON.stringify({ error: "not found", key }, null, 2), { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream" }
    });
  }

  if (req.method === "GET" && pathname === "/spec/templates") {
    return new Response(specJSON(), { headers: { "content-type": "application/json" } });
  }

  if (req.method === "GET" && pathname === "/debug/env") {
    return new Response(
      JSON.stringify({
        hasStreamToken: !!env.STREAM_API_TOKEN,
        streamAccountIdSet: !!env.STREAM_ACCOUNT_ID,
        hasAI: !!env.AI,
        publicBaseUrl: env.PUBLIC_BASE_URL,
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  if (pathname === "/debug/d1/tables") {
    const r = await env.pyTOmp4_d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    return new Response(JSON.stringify(r.results?.map((x: any) => x.name), null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  // 1) /debug/tts -> quick WAV smoke test
  if (pathname === "/debug/tts" && req.method === "GET") {
    const out = await synthesizeLine(env, "Hello from Workers AI text to speech");
    return new Response(out.bytes, { headers: { "content-type": out.contentType } });
  }


  // 2) /debug/stream/direct-upload -> see an uploadURL
  if (pathname === "/debug/stream/direct-upload" && req.method === "GET") {
    try {
      // Cast to any to allow meta until the stream helper type is updated to include it.
      const r = await createDirectUpload(env, { meta: { test: true } } as any);
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }, null, 2), { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  if (req.method === "GET" && pathname.startsWith("/debug/render-payload/")) {
    const jobId = pathname.split("/").pop()!;
    const base = `jobs/${jobId}`;

    // read algo (optional; nice to show)
    const row = await env.pyTOmp4_d1
      .prepare("SELECT algo FROM jobs WHERE id = ?1")
      .bind(jobId)
      .first<{ algo: string }>();

    // signed URLs for the three JSON blobs
    const eventsUrl = await makeSignedUrl(env, `${base}/events.json`);
    const narrationUrl = await makeSignedUrl(env, `${base}/narration.json`);
    const complexityUrl = await makeSignedUrl(env, `${base}/complexity.json`);
    const syncUrl = await makeSignedUrl(env, `${base}/sync.json`);

    // list audio keys and build signed URLs
    const list = await env.pytomp4_r2.list({ prefix: `${base}/audio/` });
    const audioKeys = list.objects.map(o => o.key).sort(); // ensure order
    const audioUrls = await Promise.all(audioKeys.map(k => makeSignedUrl(env, k)));

    return json({
      jobId,
      algo_id: row?.algo ?? "unknown",
      assets: { eventsUrl, narrationUrl, complexityUrl, audioUrls, syncUrl },
      note: "This mirrors the render queue payload (fresh signed URLs)."
    });
  }

  // inside your main request handler:
  if (req.method === "GET" && pathname === "/ai/prompts/preview") {
    const url = new URL(req.url);
    const code =
      url.searchParams.get("code") ||
      `def search_rotated_sorted_array(nums, target):
      left, right = 0, len(nums) - 1
      while left <= right:
          mid = (left + right) // 2
          if nums[mid] == target:
              return mid
          if nums[left] <= nums[mid]:
              if nums[left] <= target < nums[mid]:
                  right = mid - 1
              else:
                  left = mid + 1
          else:
              if nums[mid] < target <= nums[right]:
                  left = mid + 1
              else:
                  right = mid - 1
      return -1`;
    const language = url.searchParams.get("language") || "python";
    const algo = url.searchParams.get("algo") || "rotated_binary_search";

    // Local helper to convert our {system,user,json?} into Workers-AI chat shape
    const toCFChatBody = (p: { system?: string; user: string; json?: boolean }) => {
      const body: any = {
        messages: [
          ...(p.system ? [{ role: "system", content: p.system }] : []),
          { role: "user", content: p.user },
        ],
      };
      if (p.json) body.response_format = { type: "json_object" };
      return body;
    };

    // Import these from your ai/prompts module at the top of the file:
    //   import {
    //     buildDetectPrompt,
    //     buildEventsPrompt,
    //     buildNarrationPrompt,
    //     buildComplexityPrompt,
    //     buildSyncPrompt
    //   } from "./ai/prompts";

    // A small, realistic storyboard stub so narration/sync prompts have context
    const eventsStub = {
      version: "1.0",
      input: { nums: [4, 5, 6, 7, 0, 1, 2], target: 0 },
      scenes: [
        { t: "TitleCard", text: "Rotated Binary Search" },
        { t: "ArrayTape", left: 0, right: 6, mid: 3 },
        { t: "Callout", text: "Left half is sorted" },
        { t: "MovePointer", which: "left", to: 4 },
      ],
    };

    // A tiny narration stub for the sync prompt
    const narrationStub = {
      lines: [
        "Let us walk through a rotated binary search to find 0.",
        "We begin with indices 0 to 6 and midpoint 3 with value 7.",
      ],
    };

    // Build raw prompts
    const detectP = buildDetectPrompt(code, language);
    const eventsP = buildEventsPrompt(algo, code, language);
    const narrP   = buildNarrationPrompt(algo, eventsStub);
    const complP  = buildComplexityPrompt(algo);
    const syncP   = buildSyncPrompt(eventsStub, narrationStub);

    // Also show the exact chat bodies you would send to env.AI.run(...)
    const chatBodies = {
      detect:     toCFChatBody(detectP),
      events:     toCFChatBody(eventsP),
      narration:  toCFChatBody(narrP),
      complexity: toCFChatBody(complP),
      sync:       toCFChatBody(syncP), // syncP.json already true inside builder
    };

    const payload = {
      inputs: { algo, language, codePreview: code.slice(0, 280) + (code.length > 280 ? " …" : "") },
      raw: { detect: detectP, events: eventsP, narration: narrP, complexity: complP, sync: syncP },
      chat_bodies: chatBodies,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }


  if (req.method === "GET" && pathname === "/ai/ping") {
    return new Response(
      JSON.stringify(
        {
          detect: env.AI_MODEL_DETECT,
          events: env.AI_MODEL_EVENTS,
          narration: env.AI_MODEL_NARRATION,
          tts: env.AI_MODEL_TTS
        },
        null,
        2
      ),
      { headers: { "content-type": "application/json" } }
    );
  }

  // health
  if (req.method === "GET" && pathname === "/health") {
    return json({ ok: true, service: "code2video-api" });
  }

// in backend/src/index.ts

if (req.method === "GET" && pathname === "/ai/validate") {
  const url = new URL(req.url);
  const language = url.searchParams.get("language") || "python";
  const code = url.searchParams.get("code") || `def search_rotated_sorted_array(nums, target):
    left, right = 0, len(nums) - 1
    while left <= right:
        mid = (left + right) // 2
        if nums[mid] == target:
            return mid
        if nums[left] <= nums[mid]:
            if nums[left] <= target < nums[mid]:
                right = mid - 1
            else:
                left = mid + 1
        else:
            if nums[mid] < target <= nums[right]:
                left = mid + 1
            else:
                right = mid - 1
    return -1`;

  const out: any = { ok: false, steps: [] };

  try {
    // DETECT
    const det = await runDetect(env, code, language);
    out.steps.push({ stage: "detect", ok: true, result: det });

    // EVENTS
    const events = await runEvents(env, det.algo_id, code, language);
    try {
      validateEventTrace(events);
      out.steps.push({ stage: "events", ok: true, scenes: events?.scenes?.length ?? 0 });
    } catch (e: any) {
      out.steps.push({ stage: "events-validate", ok: false, error: String(e?.message || e) });
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" }, status: 400 });
    }

    // NARRATION
    const narration = await runNarration(env, det.algo_id, events);
    try {
      validateNarration(narration);
      out.steps.push({ stage: "narration", ok: true, lines: narration?.lines?.length ?? 0 });
    } catch (e: any) {
      out.steps.push({ stage: "narration-validate", ok: false, error: String(e?.message || e) });
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" }, status: 400 });
    }

    // COMPLEXITY
    const complexity = await runComplexity(env, det.algo_id);
    try {
      validateComplexity(complexity);
      out.steps.push({ stage: "complexity", ok: true });
    } catch (e: any) {
      out.steps.push({ stage: "complexity-validate", ok: false, error: String(e?.message || e) });
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" }, status: 400 });
    }

    // SYNC
    const sync = await runSync(env, events, narration);
    const scenes = events?.scenes?.length ?? 0;
    const pairs = sync?.pairs?.length ?? -1;
    out.steps.push({ stage: "sync", ok: true, pairs, scenes, length_ok: pairs === scenes });
    if (pairs !== scenes) {
      out.steps.push({ stage: "sync-validate", ok: false, error: `pairs.length (${pairs}) != scenes.length (${scenes})` });
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" }, status: 400 });
    }

    out.ok = true;
    return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
  } catch (err: any) {
    const msg =
      err instanceof Error
        ? `${err.message}${err.stack ? "\n" + err.stack : ""}`
        : typeof err === "string"
        ? err
        : JSON.stringify(err);
    out.steps.push({ stage: "threw", ok: false, error: msg });
    return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" }, status: 500 });
  }
}


  // POST /api/jobs/:id/callback
  if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/callback")) {
    const parts = pathname.split("/");
    const jobId = parts[3];

    // Bearer auth
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${env.CALLBACK_TOKEN}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" }
      });
    }

    // Parse body
    let body: any = {};
    try { body = await req.json(); } catch {}
    const status = body?.status as "done" | "failed";
    const message = typeof body?.message === "string" ? body.message : null;

    // we accept playbackUrl directly, OR infer it from streamUid
    const streamUid = typeof body?.streamUid === "string" ? body.streamUid : null;
    const playbackUrlIn = typeof body?.playbackUrl === "string" ? body.playbackUrl : null;
    const playbackUrl = playbackUrlIn ?? (streamUid ? `https://watch.cloudflarestream.com/${streamUid}` : null);

    if (!["done", "failed"].includes(status)) {
      return new Response(JSON.stringify({ error: "invalid status" }), {
        status: 400, headers: { "content-type": "application/json" }
      });
    }

    // Ensure job exists
    const exists = await env.pyTOmp4_d1
      .prepare("SELECT id FROM jobs WHERE id = ?")
      .bind(jobId).first<string>();
    if (!exists) {
      return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404, headers: { "content-type": "application/json" }
      });
    }

    // Update row (uses playback_url column!)
    await env.pyTOmp4_d1.prepare(
      `UPDATE jobs
        SET status = ?,
            stream_uid = ?,
            playback_url = ?,
            message = ?,
            updated_at = strftime('%s','now')
      WHERE id = ?`
    ).bind(status, streamUid, playbackUrl, message, jobId).run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" }
    });
  }

  // POST /api/jobs
  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const code = (body.code ?? "").toString();
    const language = (body.language ?? "").toString();
    const leetcodeId = body.leetcodeId ? String(body.leetcodeId) : null;

    // minimal validation
    if (!code || code.length > 40000) return json({ error: "invalid code" }, 400);
    if (!["python", "java", "js"].includes(language)) return json({ error: "invalid language" }, 400);

    const jobId = crypto.randomUUID();

    await insertJob(env.pyTOmp4_d1, {
      id: jobId, created_at: nowSec(), updated_at: nowSec(),
      status: "queued", language, leetcode_id: leetcodeId,
      algo: null, playback_url: null, stream_uid: null, message: null
    });

    // Enqueue the prep job
    await env.prep_queue.send({
      jobId, code, language, leetcodeId, size:code.length
    });

    // (In a later subtask we’ll enqueue the “prep” job here)
    return json({ jobId }, 201);
  }

  // GET /api/jobs/:id
  if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const jobId = pathname.split("/").pop()!;
    const row = await getJob(env.pyTOmp4_d1, jobId);
    if (!row) return json({ error: "not found" }, 404);
    return json({
        id: row.id,
        status: row.status,
        language: row.language,
        algo: row.algo,
        playbackUrl: row.playback_url ?? null,  // ← expose as camelCase if you prefer
        streamUid: row.stream_uid ?? null,
        message: row.message ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
},

async queue(batch: MessageBatch<any>, env: Env) {
    for (const msg of batch.messages) {
      const { jobId, code, language } = msg.body ?? {};
      try {
        // 1) prepping
        await updateJob(env.pyTOmp4_d1, jobId, { status: "prepping" });

        // 2) AI prep + validation
        const { det, events, narration, complexity } = await runPrep(env, code, language);
        const syncPlan = await runSync(env, events, narration);

        // 3) Save JSON assets to R2
        const base = `jobs/${jobId}`;
        await putJSON(env.pytomp4_r2, `${base}/events.json`, events);
        await putJSON(env.pytomp4_r2, `${base}/complexity.json`, complexity);
        await putJSON(env.pytomp4_r2, `${base}/sync.json`, syncPlan);

        // after you have: events, narration, syncPlan
        const scenes: any[] = Array.isArray(events?.scenes)
          ? events.scenes
          : (Array.isArray(events) ? events : []);

        let rawLines: string[] = Array.isArray(narration?.lines) ? narration.lines : [];
        if (rawLines.length === 0) {
          rawLines = buildSceneLinesSmart(
            scenes,
            events?.input?.nums as number[] | undefined,
            events?.input?.target as number | undefined
          );
        }

        // normalize narration lines for TTS
        const norm = (s: string) => normalizeNarrLine(String(s || ""));

        // build per-scene fused text using the sync plan
        let pairs: number[][] = Array.isArray((syncPlan as any)?.pairs) ? (syncPlan as any).pairs : [];
        if (pairs.length !== scenes.length) {
          // fallback: 1:1 pairing, capped by shorter length
          pairs = scenes.map((_, i) => (i < rawLines.length ? [i] : []));
        }

        // join lines per scene (empty array -> silence)
        const fusedByScene: string[] = pairs.map(idxList =>
          norm(idxList.map(i => rawLines[i]).filter(Boolean).join(" "))
        );

        // persist final narration we actually TTS
        await putJSON(env.pytomp4_r2, `${base}/narration.json`, {
          version: "1.0",
          lines: fusedByScene
        });

        // TTS: one clip per scene, in order
        const audioKeys: string[] = [];
        for (let i = 0; i < fusedByScene.length; i++) {
          const text = fusedByScene[i] || ""; // silence if empty
          let key = `${base}/audio/${String(i).padStart(3, "0")}.wav`;
          try {
            const clip0 = await synthesizeLine(env, text);
            const clip = normalizeTTS(clip0);     
            const ext = (clip as any).ext ?? "wav";
            const ctype = (clip as any).contentType ?? "audio/wav";
            key = `${base}/audio/${String(i).padStart(3, "0")}.${clip.ext}`
            await putBytes(env.pytomp4_r2, key, clip.bytes, clip.contentType);  // ✅ uses bytes
          } catch {
            const silence = makeOneSecondSilenceWav();
            await putBytes(env.pytomp4_r2, key, new Uint8Array(silence), "audio/wav");
          }
          audioKeys.push(key);
        }

        // 5) Create Stream Direct Upload
        const direct = await createDirectUpload(env as any, { meta: { jobId, algo: det.algo_id } } as any);

        // 6) Build short-lived signed URLs for renderer
        const eventsUrl     = await makeSignedUrl(env, `${base}/events.json`);
        const narrationUrl  = await makeSignedUrl(env, `${base}/narration.json`);
        const complexityUrl = await makeSignedUrl(env, `${base}/complexity.json`);
        const syncUrl      = await makeSignedUrl(env, `${base}/sync.json`);
        const audioUrls     = await Promise.all(audioKeys.map(k => makeSignedUrl(env, k)));

        // 7) Enqueue render job with signed URLs + uploadURL
        console.log("RENDER_MSG", JSON.stringify({ jobId, algo_id: det.algo_id, assets: { eventsUrl, syncUrl, narrationUrl, complexityUrl, audioUrls }, stream: { uploadURL: direct.uploadURL } }));
        await env.py_to_mp4_render.send({
          jobId,
          algo_id: det.algo_id,
          assets: {
            eventsUrl,
            narrationUrl,
            complexityUrl,
            syncUrl,
            audioUrls
          },
          stream: {
            uploadURL: direct.uploadURL
          }
        });

        // 8) Mark ready
        await updateJob(env.pyTOmp4_d1, jobId, {
          status: "ready_to_render",
          algo: det.algo_id,
          message: "assets signed; render job enqueued"
        });

        msg.ack();
     } catch (err: any) {
        const err_msg =
          err instanceof Error
            ? `${err.message}${err.stack ? "\n" + err.stack : ""}`
            : typeof err === "string"
            ? err
            : JSON.stringify(err);

        console.error("PREP error", jobId, err_msg);

        await updateJob(env.pyTOmp4_d1, jobId, {
          status: "failed",
          message: err_msg.slice(0, 500) // store a trimmed, readable reason
        });

        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<Env>;
