from manim import *
from .base import TimedScene

class ResultCard(TimedScene):
    def __init__(self, *args, text="Result", **kwargs):
        self.text = text
        super().__init__(*args, **kwargs)

    def construct(self):
        title = Text("Result", weight=BOLD).scale(0.9)
        body = Text(self.text).scale(0.7)
        box = RoundedRectangle(corner_radius=0.2, width=8, height=2.2)
        grp = VGroup(box, title, body).arrange(DOWN, buff=0.3).move_to(ORIGIN)

        self.play(FadeIn(box), run_time=0.2)
        self.play(Write(title), run_time=0.3)
        self.play(Write(body), run_time=0.4)
        self.finish_with_wait(1.0)
