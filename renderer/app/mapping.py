from typing import Any, Dict, Tuple, Type
from manim import config
from .templates.title_card import TitleCard
from .templates.complexity_card import ComplexityCard
from .templates.array_tape import ArrayTape
from .templates.callout import Callout
from .templates.result_card import ResultCard
from .templates.move_pointer import MovePointer

SceneMap: Dict[str, Type] = {
    "title_card": TitleCard,
    "complexity_card": ComplexityCard,
    "array_tape": ArrayTape,
    "callout": Callout,
    "result_card": ResultCard,
    "move_pointer": MovePointer,   
}


def coerce_args(event: Dict[str, Any]) -> Tuple[type, Dict[str, Any]]:
    etype = event.get("type")
    SceneCls = SceneMap.get(etype, TitleCard)
    args = event.get("args") or {}
    if SceneCls is TitleCard:
        args.setdefault("title", event.get("title") or "Algorithm")
        args.setdefault("subtitle", event.get("subtitle") or "")
    return SceneCls, args

def apply_manim_defaults():
    config.pixel_width = 1280
    config.pixel_height = 720
    config.frame_rate = 30
    config.background_color = "#000000"
