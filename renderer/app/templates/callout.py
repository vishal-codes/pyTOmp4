# renderer/app/templates/callout.py
from manim import *
from .base import TimedScene

class Callout(TimedScene):
    def __init__(self, *args, text="Note", **kwargs):
        self.text = text
        super().__init__(*args, **kwargs)

    def construct(self):
        box = RoundedRectangle(corner_radius=0.2, width=8, height=1.4).set_stroke(YELLOW, width=3)
        txt = Text(self.text).scale(0.6)
        grp = VGroup(box, txt)
        grp.move_to(ORIGIN)              # overlay text on the box (no arrange(CENTER))
        self.play(FadeIn(box), run_time=0.2)
        self.play(Write(txt), run_time=0.5)
        self.finish_with_wait(0.9)
