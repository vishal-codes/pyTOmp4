from typing import List, Dict, Any

def normalize_events(raw: Any) -> List[Dict[str, Any]]:
    """
    Accepts:
      • our template list: [{type, args}, ...]
      • generic list of steps
      • object with {"events":[...]} or {"scenes":[...], "input":{nums:...}}
        using 't' codes like TitleCard, ArrayTape, MovePointer, Callout, ComplexityCard, ResultCard.
    Returns normalized list of {type, args}.
    """
    # 1) If it's already a list of {type, args}
    if isinstance(raw, list):
        out = []
        for ev in raw:
            if "type" in ev and "args" in ev:
                out.append(ev)
            else:
                # fallback generic mapping
                step = (ev.get("step") or "").lower() if isinstance(ev, dict) else ""
                if step in ("title","intro"):
                    out.append({"type":"title_card","args":{
                        "title": ev.get("title") or "Algorithm",
                        "subtitle": ev.get("subtitle") or ""
                    }})
                elif step in ("array","state"):
                    out.append({"type":"array_tape","args":{
                        "values": ev.get("values") or [],
                        "pointers": ev.get("pointers") or {},
                        "highlight": ev.get("highlight") or []
                    }})
                elif step in ("complexity","big_o"):
                    out.append({"type":"complexity_card","args":{
                        "time_complexity": ev.get("time") or "O(n)",
                        "space_complexity": ev.get("space") or "O(1)"
                    }})
                else:
                    out.append({"type":"title_card","args":{
                        "title": ev.get("title") or (step.capitalize() if step else "Step"),
                        "subtitle": ev.get("subtitle") or ""
                    }})
        return out

    # 2) If it's a dict wrapper
    if isinstance(raw, dict):
        # common wrappers
        if "events" in raw and isinstance(raw["events"], list):
            return normalize_events(raw["events"])

        if "scenes" in raw and isinstance(raw["scenes"], list):
            nums = ((raw.get("input") or {}).get("nums")) or []
            pointer_state: Dict[str, int] = {}
            out: List[Dict[str, Any]] = []
            for s in raw["scenes"]:
                if not isinstance(s, dict): continue
                t = s.get("t")

                if t == "MovePointer":
                    which, to = s.get("which"), s.get("to")
                    if which in ("left","mid","right") and isinstance(to, int):
                        prev = pointer_state.get(which)
                        # produce a move scene if we know where we're moving from
                        if isinstance(prev, int) and prev != to:
                            out.append({"type": "move_pointer", "args":{
                                "values": nums, "which": which, "frm": prev, "to": to
                            }})
                        pointer_state[which] = to
                    continue

                if t == "TitleCard":
                    out.append({"type":"title_card","args":{
                        "title": s.get("text") or "Algorithm", "subtitle": ""
                    }})
                    continue

                if t == "ArrayTape":
                    # merge pointer state + explicit overrides
                    pointers = dict(pointer_state)
                    for k in ("left","mid","right"):
                        if k in s: pointers[k] = s[k]
                    out.append({"type":"array_tape","args":{
                        "values": nums, "pointers": pointers
                    }})
                    continue

                if t == "Callout":
                    out.append({"type":"callout","args":{"text": s.get("text") or ""}})
                    continue

                if t == "ComplexityCard":
                    out.append({"type":"complexity_card","args":{
                        "time_complexity": s.get("time") or "O(log n)",
                        "space_complexity": s.get("space") or "O(1)"
                    }})
                    continue

                if t == "ResultCard":
                    out.append({"type":"result_card","args":{"text": s.get("text") or "Result"}})
                    continue

                out.append({"type":"title_card","args":{
                    "title": str(t) if t else "Step", "subtitle": ""
                }})
            return out


    # 3) Fallback: single object → list
    if isinstance(raw, dict):
        return normalize_events([raw])
    raise ValueError("Unsupported events format")
