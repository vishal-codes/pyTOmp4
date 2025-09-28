from manim import *
from .base import TimedScene

class ComplexityCard(TimedScene):
    def __init__(self, *args, time_complexity="O(n)", space_complexity="O(1)", **kwargs):
        self.tc = time_complexity
        self.sc = space_complexity
        super().__init__(*args, **kwargs)

    def construct(self):
        title = Text("Complexity", weight=BOLD).scale(0.9)
        tc = Text(f"Time: {self.tc}")
        sc = Text(f"Space: {self.sc}")
        box = RoundedRectangle(corner_radius=0.2, width=8, height=3)
        text = VGroup(title, tc, sc).arrange(DOWN, buff=0.3)
        card = VGroup(box, text).move_to(ORIGIN)

        self.play(FadeIn(box), run_time=0.3)
        self.play(Write(title), run_time=0.3)
        self.play(Write(tc), Write(sc), run_time=0.4)
        self.finish_with_wait()
