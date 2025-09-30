# renderer/app/manim_render.py
import json, tempfile, gzip, shutil, subprocess, os
from pathlib import Path
from typing import List, Dict, Any
from manim import tempconfig
from .normalizer import normalize_events
from .mapping import coerce_args, apply_manim_defaults

MIN_SCENE = float(os.getenv("MIN_SCENE", "1.2"))
TAIL_PAD  = float(os.getenv("TAIL_PAD", "0.25"))
PACE_MULT = float(os.getenv("PACE_MULT", "1.0"))

def _load_sync(sync_path: Path, scenes_count: int) -> dict:
    if not sync_path.exists():
        return {"pairs": [[i] for i in range(scenes_count)], "breath_gap_sec": 0.12}
    with open(sync_path, "r") as f:
        plan = json.load(f)
    pairs = plan.get("pairs") or []
    if len(pairs) != scenes_count:
        # fallback: identity mapping
        pairs = [[i] for i in range(scenes_count)]
    gap = float(plan.get("breath_gap_sec", 0.12))
    return {"pairs": pairs, "gap": max(0.0, min(2.0, gap))}

def _pad_audio_to(a_in: Path, a_out: Path, target_sec: float):
    """Append silence if needed so audio >= target_sec."""
    dur = _ffprobe_duration(a_in)
    if dur >= target_sec - 1e-3:
        subprocess.check_call(["ffmpeg","-y","-i",str(a_in),"-c","copy",str(a_out)])
        return
    pad = max(0.0, target_sec - dur)
    with tempfile.TemporaryDirectory() as td:
        sil = Path(td)/"sil.m4a"
        subprocess.check_call([
            "ffmpeg","-y","-f","lavfi","-t",f"{pad:.3f}",
            "-i","anullsrc=r=44100:cl=mono","-c:a","aac",str(sil)
        ])
        merged = Path(td)/"merged.m4a"
        subprocess.check_call([
            "ffmpeg","-y","-i",str(a_in),"-i",str(sil),
            "-filter_complex","[0:a][1:a]concat=n=2:v=0:a=1[a]",
            "-map","[a]","-c:a","aac", str(merged)
        ])
        shutil.move(merged, a_out)

def _ffprobe_duration(p: Path) -> float:
    try:
        out = subprocess.check_output(
            ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nk=1:nw=1", str(p)],
            text=True
        ).strip()
        return max(0.2, float(out))
    except Exception:
        return 2.0

def _load_events_any(p: Path) -> List[Dict[str, Any]]:
    b = p.read_bytes()
    if len(b) >= 2 and b[:2] == b"\x1f\x8b":  # gz header
        b = gzip.decompress(b)
    text = b.decode("utf-8", errors="replace")
    obj = json.loads(text)
    if isinstance(obj, str):
        obj = json.loads(obj)
    if isinstance(obj, dict) and "events" in obj:
        obj = obj["events"]
    if isinstance(obj, dict) and "scenes" in obj:
        # keep dict; normalizer will handle {"input":..., "scenes":[...]}
        pass
    if isinstance(obj, dict):
        # could be a single event; normalize accepts dict too
        pass
    elif not isinstance(obj, list):
        raise ValueError(f"events root must be list or object, got {type(obj)}")
    return obj

def _render_scene(SceneCls, args: Dict[str,Any], duration: float, out_mp4: Path):
    # inject duration into scene subclass
    class _Scene(SceneCls):
        def __init__(self, **kw):
            d = kw.pop("duration", duration)
            super().__init__(duration=d, **kw)

    tmp = out_mp4.parent / f"{out_mp4.stem}_manim.mp4"
    with tempconfig({"pixel_width":1280,"pixel_height":720,"frame_rate":30}):
        sc = _Scene(**args)
        sc.render()
        produced = sc.renderer.file_writer.movie_file_path
        shutil.move(produced, tmp)

    subprocess.check_call([
        "ffmpeg","-y","-i",str(tmp),
        "-c:v","libx264","-pix_fmt","yuv420p","-an", str(out_mp4)
    ])

def _mux(video: Path, audio: Path, out_path: Path):
    subprocess.check_call([
        "ffmpeg","-y","-i",str(video),"-i",str(audio),
        "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",
        str(out_path)
    ])

def _concat(clips: List[Path], out_path: Path):
    lst = out_path.with_suffix(".txt")
    with open(lst,"w") as f:
        for p in clips:
            f.write(f"file '{p.as_posix()}'\n")
    subprocess.check_call([
        "ffmpeg","-y","-f","concat","-safe","0","-i",str(lst),
        "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac", str(out_path)
    ])

def _synthesize_silence(seconds: float, out_audio: Path):
    # generate a tiny silence (stereo 48k) once per needed duration
    subprocess.check_call([
        "ffmpeg","-y","-f","lavfi","-i",f"anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t",f"{seconds:.3f}","-c:a","aac","-b:a","160k", str(out_audio)
    ])

def _concat_audios(audios: list[Path], gap_sec: float, out_audio: Path):
    # Create a concat list. If gap_sec > 0, insert synthetic silence between clips.
    items = []
    if not audios:
        _synthesize_silence(0.6, out_audio)  # default silent placeholder
        return
    tmpdir = out_audio.parent
    if gap_sec > 0 and len(audios) > 1:
        sil = tmpdir / f"sil_{int(gap_sec*1000)}.m4a"
        if not sil.exists():
            _synthesize_silence(gap_sec, sil)
        # build interleaved [a1, sil, a2, sil, ..., an]
        for i, a in enumerate(audios):
            items.append(a)
            if i+1 < len(audios):
                items.append(sil)
    else:
        items = list(audios)

    lst = out_audio.with_suffix(".concat.txt")
    with open(lst, "w") as f:
        for p in items:
            f.write(f"file '{p.as_posix()}'\n")

    subprocess.check_call([
        "ffmpeg","-y","-f","concat","-safe","0","-i",str(lst),
        "-c:a","aac","-b:a","160k", str(out_audio)
    ])

def render_manim(events_json: Path, audio_files: List[Path], out_mp4: Path, sync_json: Path|None=None):
    apply_manim_defaults()

    raw = _load_events_any(events_json)
    root = raw if isinstance(raw, dict) else None
    events = normalize_events(raw)

    # --- NEW: sync plan
    sync = _load_sync(sync_json or Path(""), len(events))
    pairs, gap = sync["pairs"], sync["gap"]

    # build per-scene audio by concatenating line clips per pair
    grouped_audio: List[Path] = []
    scratch = out_mp4.parent
    for i, line_ids in enumerate(pairs):
        # map narration indices to local audio files (skip OOB safely)
        parts = [audio_files[j] for j in line_ids if 0 <= j < len(audio_files)]
        out_a = scratch / f"group_{i:03d}.m4a"
        _concat_audios(parts, gap, out_a)
        grouped_audio.append(out_a)

    pairs2 = list(zip(events, grouped_audio))[:min(len(events), len(grouped_audio))]
    if not pairs2:
        raise RuntimeError("no events/audio pairs")

    clips: List[Path] = []
    ok = 0
    for i, (ev, aud) in enumerate(pairs2):
        try:
            SceneCls, args = coerce_args(ev, events_root=root)
            a_dur = max(0.2, _ffprobe_duration(aud))
            d = max(MIN_SCENE, a_dur + TAIL_PAD)

            vid = out_mp4.parent / f"clip_{i:03d}.mp4"
            av  = out_mp4.parent / f"clip_{i:03d}_av.mp4"

            _render_scene(SceneCls, args, d, vid)

            padded = aud.with_suffix(".padded.m4a")
            _pad_audio_to(aud, padded, d * PACE_MULT)
            _mux(vid, padded, av)

            clips.append(av); ok += 1
        except Exception as e:
            print(f"WARN: scene {i} failed: {e}")
            d = max(MIN_SCENE, _ffprobe_duration(aud) + TAIL_PAD)
            vid = out_mp4.parent / f"clip_{i:03d}.mp4"
            _render_scene(Callout, {"text": "Step"}, d, vid)
            padded = aud.with_suffix(".padded.m4a")
            _pad_audio_to(aud, padded, d)
            av = out_mp4.parent / f"clip_{i:03d}_av.mp4"
            _mux(vid, padded, av)
            clips.append(av)

    if ok == 0:
        raise RuntimeError("no scenes rendered")
    _concat(clips, out_mp4)
