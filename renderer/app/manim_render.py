# import json, shutil, subprocess
# from pathlib import Path
# from typing import List, Dict, Any, Tuple
# from manim import config, tempconfig
# from .normalizer import normalize_events
# from .mapping import coerce_args, apply_manim_defaults
# import gzip


# def _ffprobe_duration(p: Path) -> float:
#     try:
#         out = subprocess.check_output(
#             ["ffprobe","-v","error","-show_entries","format=duration","-of","default=nk=1:nw=1", str(p)],
#             text=True).strip()
#         return float(out)
#     except Exception:
#         return 2.0

# def _render_scene(SceneCls, args: Dict[str,Any], duration: float, out_mp4: Path):
#     # import here to avoid heavy import on module import
#     from .templates.base import TimedScene
#     class _Scene(SceneCls):
#         def __init__(self, **kw):
#             d = kw.pop("duration", duration)
#             super().__init__(duration=d, **kw)

#     tmp = out_mp4.parent / f"{out_mp4.stem}_manim.mp4"
#     with tempconfig({"pixel_width":1280,"pixel_height":720,"frame_rate":30}):
#         sc = _Scene(**args)
#         sc.render()
#         produced = sc.renderer.file_writer.movie_file_path
#         shutil.move(produced, tmp)

#     subprocess.check_call([
#         "ffmpeg","-y","-i",str(tmp),"-c:v","libx264","-pix_fmt","yuv420p","-an",str(out_mp4)
#     ])

# def _mux(video: Path, audio: Path, out_path: Path):
#     subprocess.check_call([
#         "ffmpeg","-y","-i",str(video),"-i",str(audio),
#         "-c:v","copy","-c:a","aac","-shortest", str(out_path)
#     ])

# def _concat(clips: List[Path], out_path: Path):
#     lst = out_path.with_suffix(".txt")
#     with open(lst,"w") as f:
#         for p in clips:
#             f.write(f"file '{p.as_posix()}'\n")
#     subprocess.check_call([
#         "ffmpeg","-y","-f","concat","-safe","0","-i",str(lst),
#         "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac", str(out_path)
#     ])

# def render_manim(events_json: Path, audio_files: List[Path], out_mp4: Path):
#     apply_manim_defaults()
#     raw = _load_events_any(events_json)
#     events = normalize_events(raw)

#     pairs = list(zip(events, audio_files))[:min(len(events), len(audio_files))]
#     if not pairs:
#         raise RuntimeError("no events/audio pairs")

#     clips: List[Path] = []
#     successes = 0
#     for i, (ev, aud) in enumerate(pairs):
#         try:
#             SceneCls, args = coerce_args(ev)
#             d = max(1.0, _ffprobe_duration(aud))
#             vid = out_mp4.parent / f"clip_{i:03d}.mp4"
#             av  = out_mp4.parent / f"clip_{i:03d}_av.mp4"
#             _render_scene(SceneCls, args, d, vid)   # Manim render
#             _mux(vid, aud, av)                      # add audio to this clip
#             clips.append(av)
#             successes += 1
#         except Exception as e:
#             print(f"WARN: scene {i} failed: {e}")   # keep going

#     if successes == 0:
#         raise RuntimeError("no scenes rendered")

#     _concat(clips, out_mp4)

# renderer/app/manim_render.py
import json, gzip, shutil, subprocess, os
from pathlib import Path
from typing import List, Dict, Any
from manim import tempconfig
from .templates.array_tape import ArrayTape
from .templates.callout import Callout
from .templates.complexity_card import ComplexityCard
from .templates.result_card import ResultCard
from .templates.title_card import TitleCard
from .normalizer import normalize_events
from .mapping import coerce_args, apply_manim_defaults
import tempfile

MIN_SCENE = float(os.getenv("MIN_SCENE", "1.2"))
TAIL_PAD  = float(os.getenv("TAIL_PAD", "0.25"))

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
        "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",
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

def render_manim(events_json: Path, audio_files: List[Path], out_mp4: Path):
    apply_manim_defaults()
    raw = _load_events_any(events_json)
    events = normalize_events(raw)

    pairs = list(zip(events, audio_files))[:min(len(events), len(audio_files))]
    if not pairs:
        raise RuntimeError("no events/audio pairs")

    clips: List[Path] = []
    ok = 0
    for i, (ev, aud) in enumerate(pairs):
        try:
            SceneCls, args = coerce_args(ev, events_root=events_json)
            a_dur = max(0.2, _ffprobe_duration(aud))
            # drive visuals from audio + tiny tail for breathing room
            d = max(MIN_SCENE, a_dur + TAIL_PAD)

            vid = out_mp4.parent / f"clip_{i:03d}.mp4"
            av  = out_mp4.parent / f"clip_{i:03d}_av.mp4"

            _render_scene(SceneCls, args, d, vid)

            # pad audio so it's >= video duration; then mux w/o -shortest
            padded = aud.with_suffix(".padded.m4a")
            _pad_audio_to(aud, padded, d)
            _mux(vid, padded, av)

            clips.append(av)
            ok += 1
        except Exception as e:
            print(f"WARN: scene {i} failed: {e}")
            # fallback text card so timeline stays aligned
            d = max(MIN_SCENE, _ffprobe_duration(aud) + TAIL_PAD)
            vid = out_mp4.parent  / f"clip_{i:03d}.mp4"
            _render_scene(Callout, {"text": "Step"}, d, vid)
            padded = aud.with_suffix(".padded.m4a")
            _pad_audio_to(aud, padded, d)
            av = out_mp4.parent  / f"clip_{i:03d}_av.mp4"
            _mux(vid, padded, av)
            clips.append(av)

    if ok == 0:
        raise RuntimeError("no scenes rendered")
    _concat(clips, out_mp4)

def coerce_args(ev: dict, events_root: dict | None = None):
    t = (ev.get("t") or ev.get("type") or "").lower()
    nums = None
    if events_root:
        nums = (events_root.get("input") or {}).get("nums")

    def pointers_from(e):
        p = e.get("pointers") or {}
        return {
            "left":  e.get("left",  p.get("left")),
            "mid":   e.get("mid",   p.get("mid")),
            "right": e.get("right", p.get("right")),
        }

    if t in ("titlecard", "title_card"):
        return TitleCard, {"text": ev.get("text") or "Algorithm"}

    if t in ("arraytape", "array_tape"):
        ptrs = pointers_from(ev)
        hi = []
        if isinstance(ptrs.get("mid"), int):
            hi = [ptrs["mid"]]
        return ArrayTape, {
            "values": nums or [],          # <— ensure values are always set
            "pointers": ptrs,
            "highlight": hi,
        }

    if t in ("movepointer", "move_pointer"):
        which = ev.get("which", "pointer")
        to = ev.get("to", "?")
        txt = f"Move {which} to index {to}"
        return Callout, {"text": txt}     # <— safe overlay, no state

    if t in ("complexitycard", "complexity_card"):
        return ComplexityCard, {
            "time":  ev.get("time")  or ev.get("time_complexity"),
            "space": ev.get("space") or ev.get("space_complexity"),
        }

    if t in ("resultcard", "result_card"):
        return ResultCard, {"text": ev.get("text") or "Done"}

    if t == "callout":
        return Callout, {"text": ev.get("text") or "Note"}

    # fallback: never crash
    return Callout, {"text": "Step"}
