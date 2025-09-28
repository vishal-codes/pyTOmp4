import base64
import os
import shutil
import subprocess
import tempfile
import time
import json, wave, math, struct
import requests
from pathlib import Path
from typing import List, Optional
from fastapi import FastAPI, Header, HTTPException, APIRouter
from pydantic import BaseModel, Field, HttpUrl, ValidationError, model_validator 
from urllib.parse import urlparse, parse_qs, unquote
from .manim_render import render_manim  
from fastapi.responses import FileResponse

# --------------------------------------------------------------------------------------
# ENV
# --------------------------------------------------------------------------------------
RENDER_TOKEN = os.getenv("RENDER_TOKEN", "dev-render-token")        # bearer expected on /render
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:8787")
CALLBACK_TOKEN = os.getenv("CALLBACK_TOKEN", "dev-callback-token")  # for /api/jobs/:id/callback

# optional: if you set STREAM_DIRECT_UPLOAD_FALLBACK=1 and payload lacks stream.uploadURL,
# we will call `${BACKEND_BASE_URL}/debug/stream/direct-upload` to obtain one.
STREAM_DIRECT_UPLOAD_FALLBACK = os.getenv("STREAM_DIRECT_UPLOAD_FALLBACK", "0") == "1"
LOCAL = os.getenv("SKIP_STREAM", "0") == "1"


# --------------------------------------------------------------------------------------
# Pydantic models & validators
# --------------------------------------------------------------------------------------
def is_stream_upload(url: str) -> bool:
    u = urlparse(url)
    return u.scheme in ("http", "https") and u.netloc.endswith("upload.cloudflarestream.com") and len(u.path.strip("/")) >= 6

class Assets(BaseModel):
    eventsUrl: HttpUrl
    narrationUrl: HttpUrl
    complexityUrl: HttpUrl
    audioUrls: List[HttpUrl] = Field(min_length=1)

class StreamInfo(BaseModel):
    uploadURL: Optional[HttpUrl] = None

    @model_validator(mode="after")
    def _check_cf_stream(self):
        if self.uploadURL is not None and not is_stream_upload(str(self.uploadURL)):
            raise ValueError("stream.uploadURL is not a Cloudflare Stream direct-upload URL")
        return self

class RenderPayload(BaseModel):
    jobId: str
    algo_id: Optional[str] = None
    assets: Assets
    stream: StreamInfo

# --------------------------------------------------------------------------------------
# FastAPI
# --------------------------------------------------------------------------------------
app = FastAPI(title="pytoMP4 Renderer", version="0.2")

# --------------------------------------------------------------------------------------
# Utility + ffmpeg helpers
# --------------------------------------------------------------------------------------
class Fail(RuntimeError):  # controlled failures that should set job->failed
    pass

def _b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()

def _check_auth(auth_header: Optional[str]):
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer")
    if auth_header[7:] != RENDER_TOKEN:
        raise HTTPException(status_code=401, detail="bad bearer")

def run(cmd: List[str]):
    # surface ffmpeg errors clearly
    subprocess.check_call(cmd)

def ffprobe_duration(path: Path) -> float:
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)]
    try:
        out = subprocess.check_output(cmd, text=True).strip()
        return float(out)
    except Exception:
        return 0.0
    
def infer_asset_filename(url: str, default: str = "asset.json") -> str:
    """
    For /assets/get?... extract the real key basename (e.g., events.json) from the query.
    Falls back to path basename, then default.
    """
    u = urlparse(url)
    qs = parse_qs(u.query)
    key = qs.get("key") or qs.get("k")
    if key:
        try:
            return Path(unquote(key[0])).name or default
        except Exception:
            pass
    name = Path(u.path).name
    return name or default

def download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        # ensure gzip/deflate are decompressed before writing
        r.raw.decode_content = True
        with open(dest, "wb") as f:
            shutil.copyfileobj(r.raw, f)
    if not dest.exists() or dest.stat().st_size == 0:
        raise FileNotFoundError(f"wrote zero bytes to {dest}")

def assemble_audio(audio_files: List[Path], out_audio: Path):
    """
    Re-encode all inputs to AAC via concat demuxer for compatibility.
    """
    if not audio_files:
        # 1s silence
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1.0", "-c:a", "aac", str(out_audio)])
        return

    # create concat list
    list_txt = out_audio.with_suffix(".txt")
    with open(list_txt, "w") as f:
        for p in audio_files:
            f.write(f"file '{p.as_posix()}'\n")

    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_txt), "-c:a", "aac", str(out_audio)])

def make_video(total_dur: float, audio_path: Path, out_mp4: Path):
    # simple black 720p background, yuv420p for cross-player compatibility
    run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=black:s=1280x720:d={max(total_dur, 0.5):.2f}",
        "-i", str(audio_path),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-shortest",
        str(out_mp4)
    ])

def tus_upload(upload_url: str, file_path: Path, filename: str = "out.mp4", mime="video/mp4"):
    size = file_path.stat().st_size
    # 1) announce upload
    headers = {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": str(size),
        "Upload-Metadata": f"filename {_b64(filename)},filetype {_b64(mime)}",
    }
    r = requests.post(upload_url, headers=headers, timeout=30)
    if r.status_code not in (201, 204):
        raise RuntimeError(f"TUS POST failed {r.status_code}: {r.text}")
    location = r.headers.get("Location") or upload_url

    # 2) PATCH bytes (streamed)
    with open(file_path, "rb") as f:
        headers = {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": "0",
            "Content-Type": "application/offset+octet-stream",
        }
        r = requests.patch(location, headers=headers, data=f, timeout=300)
        if r.status_code != 204:
            raise RuntimeError(f"TUS PATCH failed {r.status_code}: {r.text}")

    uid = Path(urlparse(upload_url).path).name
    return uid

# NEW: basic direct-upload (multipart/form-data)
def basic_upload(upload_url: str, file_path: Path):
    with open(file_path, "rb") as f:
        r = requests.post(upload_url, files={"file": (file_path.name, f, "video/mp4")}, timeout=300)
    if r.status_code != 200:
        raise RuntimeError(f"basic upload failed {r.status_code}: {r.text}")
    # uid is the last path segment of upload_url for direct-upload
    return Path(urlparse(upload_url).path).name

def backend_callback(job_id: str, status: str, message: Optional[str], stream_uid: Optional[str], playback_url: Optional[str]):
    url = f"{BACKEND_BASE_URL}/api/jobs/{job_id}/callback"
    headers = {
        "Authorization": f"Bearer {CALLBACK_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "status": status,
        "message": message,
        "streamUid": stream_uid,
        "playbackUrl": playback_url,
    }
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    if r.status_code >= 300:
        raise RuntimeError(f"callback failed {r.status_code}: {r.text}")

def safe_callback(job_id, status, message, uid=None, playback=None):
    try:
        backend_callback(job_id, status, message, uid, playback)
    except Exception as e:
        print("CALLBACK_ERROR:", repr(e))

# --------------------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------------------

@app.post("/demo/local")
def demo_local():
    td = Path("/tmp/demo")
    td.mkdir(parents=True, exist_ok=True)

    # 3 short tones = 3 scenes (2s each)
    tones = [440, 660, 550]
    audio_files = []
    for i, freq in enumerate(tones):
        p = td / f"{i:03d}.wav"
        with wave.open(str(p), "w") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
            for n in range(44100 * 2):
                val = int(32767 * 0.2 * math.sin(2*math.pi*freq*n/44100))
                w.writeframes(struct.pack("<h", val))
        audio_files.append(p)

    # hard-coded events (template format)
    events = [
        {"type":"title_card","args":{"title":"Demo Works!","subtitle":"Manim + Audio"}},
        {"type":"array_tape","args":{"values":[4,5,6,7,0,1,2],"pointers":{"left":0,"mid":3,"right":6}}},
        {"type":"complexity_card","args":{"time_complexity":"O(log n)","space_complexity":"O(1)"}}
    ]
    ev_path = td / "events.json"
    ev_path.write_text(json.dumps(events), encoding="utf-8")

    out_dir = Path(os.getenv("LOCAL_OUTPUT_DIR", "/output"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = out_dir / "manim_demo.mp4"

    render_manim(ev_path, audio_files, out_mp4)
    return {"ok": True, "localPath": str(out_mp4)}

@app.post("/demo/rotated_bs")
def demo_rotated_bs():
    td = Path("/tmp/demo_bs"); td.mkdir(parents=True, exist_ok=True)
    # Your schema
    raw = {
      "version":"1.0",
      "input":{"nums":[4,5,6,7,0,1,2], "target":0},
      "scenes":[
        {"t":"TitleCard","text":"Binary Search (Rotated)"},
        {"t":"ArrayTape","left":0,"right":6,"mid":3},
        {"t":"Callout","text":"Left half is sorted"},
        {"t":"MovePointer","which":"left","to":4},
        {"t":"ArrayTape","left":4,"right":6,"mid":5},
        {"t":"MovePointer","which":"right","to":4},
        {"t":"ArrayTape","left":4,"right":4,"mid":4},
        {"t":"ComplexityCard"},
        {"t":"ResultCard","text":"Found at index 4"}
      ]
    }
    ev_path = td/"events.json"; ev_path.write_text(json.dumps(raw), encoding="utf-8")

    # make per-scene audio (durations tuned for nicer pacing)
    import wave, math, struct
    durs = [2.8, 2.5, 2.0, 1.8, 2.5, 1.8, 2.5, 2.5, 2.5]  # ~21s total
    freqs= [440, 520, 580, 600, 520, 480, 520, 440, 420]  # just different tones
    audio_files=[]
    sr = 44100
    for i,(sec,hz) in enumerate(zip(durs,freqs)):
        p = td / f"{i:03d}.wav"
        with wave.open(str(p),"w") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            for n in range(int(sr*sec)):
                val = int(32767*0.2*math.sin(2*math.pi*hz*n/sr))
                w.writeframes(struct.pack("<h", val))
        audio_files.append(p)

    out_dir = Path(os.getenv("LOCAL_OUTPUT_DIR","/output")); out_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = out_dir / "rotated_bs_demo.mp4"
    # Use Manim path directly
    render_manim(ev_path, audio_files, out_mp4)
    return {"ok": True, "localPath": str(out_mp4)}

@app.get("/files/{name}")
def get_file(name: str):
    p = Path("/output") / name
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(p), media_type="video/mp4")

@app.get("/healthz")
def healthz():
    return {"ok": True, "time": int(time.time())}

@app.get("/readyz")
def readyz():
    # naive: ensure ffmpeg is callable
    try:
        subprocess.check_output(["ffmpeg", "-version"])
    except Exception:
        return {"ok": False}
    return {"ok": True}

@app.post("/render")
def render(payload: RenderPayload, authorization: Optional[str] = Header(None)):
    _check_auth(authorization)

    job_id = payload.jobId
    upload_url = str(payload.stream.uploadURL) if payload.stream.uploadURL else None

    # optional fallback: ask backend for a direct-upload if missing
    if upload_url is None and STREAM_DIRECT_UPLOAD_FALLBACK:
        try:
            r = requests.get(f"{BACKEND_BASE_URL}/debug/stream/direct-upload", timeout=15)
            r.raise_for_status()
            upload_url = r.json()["uploadURL"]
        except Exception as e:
            safe_callback(job_id, "failed", f"VALIDATION_ERROR: missing stream.uploadURL and fallback failed: {e}")
            raise HTTPException(status_code=422, detail="stream.uploadURL missing")

    if upload_url is None:
        safe_callback(job_id, "failed", "VALIDATION_ERROR: stream.uploadURL missing")
        raise HTTPException(status_code=422, detail="stream.uploadURL missing")

    try:
        # Preflight: HEAD first audio to catch expired signature
        try:
            first_audio = str(payload.assets.audioUrls[0])
            r = requests.head(first_audio, timeout=10, allow_redirects=True)
            if r.status_code != 200:
                raise Fail(f"VALIDATION_ERROR: first audio HEAD {r.status_code}")
        except requests.RequestException as e:
            raise Fail(f"FETCH_ERROR: audio HEAD failed: {e}")

        # ↓↓↓ everything happens inside this tempdir ↓↓↓
        with tempfile.TemporaryDirectory() as td_str:
            td = Path(td_str)

            # Download JSON assets
            ev = nar = cx = None
            for kind, url in [
                ("events", str(payload.assets.eventsUrl)),
                ("narration", str(payload.assets.narrationUrl)),
                ("complexity", str(payload.assets.complexityUrl)),
            ]:
                try:
                    name = infer_asset_filename(url, default=f"{kind}.json")
                    dest = td / name
                    download(url, dest)
                    if kind == "events": ev = dest
                    elif kind == "narration": nar = dest
                    else: cx = dest
                except Exception as e:
                    print("WARN: JSON asset fetch failed:", url, e)

            # Download per-scene audio
            audio_files: List[Path] = []
            for i, aurl in enumerate(payload.assets.audioUrls):
                aurl = str(aurl)
                name = infer_asset_filename(aurl, default=f"{i:03d}.mp3")
                ext = Path(name).suffix or ".mp3"
                p = td / f"{i:03d}{ext}"
                download(aurl, p)
                audio_files.append(p)

            if not audio_files:
                raise Fail("VALIDATION_ERROR: no audio files")

            # Concat total audio (fallback only)
            out_audio = td / "combined.m4a"
            assemble_audio(audio_files, out_audio)

            # Render (prefer Manim)
            out_mp4 = td / "out.mp4"
            try:
                use_manim = os.getenv("USE_MANIM", "1") == "1" and ev and audio_files
                if use_manim:
                    render_manim(ev, audio_files, out_mp4)
                else:
                    total = sum((ffprobe_duration(p) or 2.0) for p in audio_files)
                    make_video(total, out_audio, out_mp4)
            except Exception as e:
                print("WARN: manim render failed, falling back:", e)
                total = sum((ffprobe_duration(p) or 2.0) for p in audio_files)
                make_video(total, out_audio, out_mp4)

            if LOCAL:
                out_dir = Path(os.getenv("LOCAL_OUTPUT_DIR", "/output")); out_dir.mkdir(parents=True, exist_ok=True)
                local_path = out_dir / f"{job_id}.mp4"
                shutil.copy2(out_mp4, local_path)
                return {"ok": True, "jobId": job_id, "localPath": str(local_path)}

            # Upload to Stream (basic direct upload)
            try:
                uid = basic_upload(upload_url, out_mp4)
            except Exception as e:
                raise Fail(f"UPLOAD_ERROR: {e}")

            playback = f"https://watch.cloudflarestream.com/{uid}"
            backend_callback(job_id, "done", "ok", uid, playback)
            return {"ok": True, "jobId": job_id, "streamUid": uid, "playbackUrl": playback}


    except ValidationError as e:
        msg = f"VALIDATION_ERROR: {e.errors()[0]['msg'] if e.errors() else 'invalid payload'}"
        safe_callback(job_id, "failed", msg)
        raise HTTPException(status_code=422, detail=str(e))
    except Fail as e:
        safe_callback(job_id, "failed", str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        safe_callback(job_id, "failed", f"RENDERER_CRASH: {e}")
        raise
