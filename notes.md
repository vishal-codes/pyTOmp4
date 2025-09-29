# run dev server
npx wrangler dev --x-remote-bindings

# db migration preview
npx wrangler d1 migrations apply pyTOmp4-d1 --remote --preview


# ✅ Sanity tests to run now

## A. API happy path

```bash
# health
curl -s http://127.0.0.1:8787/health | jq

# spec + prompts wired
curl -s http://127.0.0.1:8787/spec/templates | jq '.version, (.scenes|keys)'
curl -s http://127.0.0.1:8787/ai/prompts/preview | jq 'keys'

# create job
JOB=$(curl -s -X POST http://127.0.0.1:8787/api/jobs \
  -H 'content-type: application/json' \
  -d '{"code":"def f(): pass","language":"python"}' | jq -r .jobId)


curl -s http://127.0.0.1:8787/api/jobs/$JOB | jq
```

## B. R2 assets present

```bash
# using your debug route from earlier (list by prefix)
curl -s "http://127.0.0.1:8787/debug/r2/list?prefix=jobs/$JOB/" | jq
# expect: events.json, narration.json, complexity.json, audio/000.wav...
```

## C. TTS audio sanity

* Local dev → you’ll get **silent WAVs** (by design fallback).
* Remote bindings → should be **spoken** audio.

```bash
# if you added /debug/tts earlier:
curl -o hello.wav http://127.0.0.1:8787/debug/tts
```

## D. Stream direct-upload works

```bash
curl -s http://127.0.0.1:8787/debug/stream/direct-upload | jq   # expect { uploadURL: ... }
```

## E. Validation & error paths

```bash
# invalid language -> 400
curl -i -s -X POST http://127.0.0.1:8787/api/jobs \
  -H 'content-type: application/json' \
  -d '{"code":"x","language":"go"}' | head -n1

# huge code -> 400
python - <<'PY' | curl -i -s -X POST http://127.0.0.1:8787/api/jobs -H 'content-type: application/json' -d @- | head -n1
import json; print(json.dumps({"code":"a"*(40001),"language":"python"}))
PY
```

To test the **failed** status end-to-end, temporarily throw inside `runPrep()` or right after validation and confirm:

```bash
curl -s http://127.0.0.1:8787/api/jobs/$JOB | jq   # expect status: "failed"
```

## F. D1 tables (you already did, but one-liner)

```bash
curl -s http://127.0.0.1:8787/debug/d1/tables | jq
```






# create a NEW job so the backend writes fresh assets
JOB=$(curl -s -X POST http://127.0.0.1:8787/api/jobs \
  -H 'content-type: application/json' \
  -d '{"code":"def f(): pass","language":"python"}' | jq -r .jobId)

# fetch a fresh render payload (should include stream.uploadURL)
curl -s "http://127.0.0.1:8787/debug/render-payload/$JOB" > payload.json


# (if your debug route does NOT include stream.uploadURL yet)
DU=$(curl -s http://127.0.0.1:8787/debug/stream/direct-upload | jq -r .uploadURL)
jq --arg u "$DU" '. + {stream:{uploadURL:$u}}' payload.json > payload2.json


# sanity: tiny GET should be 200/206 and audio/*
<!-- URL=$(jq -r '.assets.audioUrls[0]' payload.json)
curl -sL -r 0-0 "$URL" -o /dev/null -w "%{http_code} %{content_type}\n" -->

curl -s -X POST http://127.0.0.1:8000/render \
  -H "Authorization: Bearer dev-render-token" \
  -H "Content-Type: application/json" \
  --data @payload2.json | jq

curl -s "http://127.0.0.1:8787/api/jobs/$JOB" | jq
# expect: status "done", streamUid + playbackUrl populated



<!-- docker -->
docker build -t pytomp4-renderer .

sudo docker run --rm --network=host \                                     
  -e RENDER_TOKEN=dev-render-token \
  -e BACKEND_BASE_URL=http://127.0.0.1:8787 \
  -e CALLBACK_TOKEN=$(grep -E '^CALLBACK_TOKEN=' ../backend/.dev.vars | cut -d= -f2-) \
  -e USE_MANIM=1 \
  pytomp4-renderer













































  # create a fresh job
JOB=$(curl -s -X POST http://127.0.0.1:8787/api/jobs \
  -H 'content-type: application/json' \
  -d '{"code":"def f(): pass","language":"python"}' | jq -r .jobId)

# confirm a 1:1 mapping between scenes and audio files
curl -s "http://127.0.0.1:8787/debug/render-payload/$JOB" | jq '.assets.audioUrls | length'
curl -s "http://127.0.0.1:8787/debug/render-payload/$JOB" | jq '.assets.eventsUrl' | xargs curl -s | jq '.scenes | length'
# both numbers should match

# verify first audio is accessible
URL=$(curl -s "http://127.0.0.1:8787/debug/render-payload/$JOB" | jq -r '.assets.audioUrls[0]')
curl -sL -r 0-0 "$URL" -o /dev/null -w "%{http_code} %{content_type}\n"
# -> 200 audio/mpeg

# if you want to keep it local (no Stream upload)
sudo docker run --rm --network=host \
  -v "$(pwd)/renderer_out:/output" \
  -e USE_MANIM=1 -e SKIP_STREAM=1 \
  -e LOCAL_OUTPUT_DIR=/output \
  -e PACE_MULT=1.8 -e STRICT_AUDIO=0 \
  pytomp4-renderer

# ask backend for the actual render payload and POST it to /render
curl -s "http://127.0.0.1:8787/debug/render-payload/$JOB" > payload.json
DU=$(curl -s http://127.0.0.1:8787/debug/stream/direct-upload | jq -r .uploadURL)
jq --arg u "$DU" '. + {stream:{uploadURL:$u}}' payload.json > payload2.json
curl -s -X POST http://127.0.0.1:8000/render \
  -H "Authorization: Bearer dev-render-token" \
  -H "Content-Type: application/json" \
  --data @payload2.json | jq

# open the local file printed by the renderer (e.g. /output/<job>.mp4)
sudo docker run --rm --network=host -e RENDER_TOKEN=dev-render-token -e BACKEND_BASE_URL=http://127.0.0.1:8787 -e CALLBACK_TOKEN="$(grep -E '^CALLBACK_TOKEN=' ../backend/.dev.vars | cut -d= -f2-)" -e USE_MANIM=1 -e SKIP_STREAM=0 -e MIN_SCENE=1.4 -e TAIL_PAD=0.35 -e PACE_MULT=1.0 pytomp4-renderer

