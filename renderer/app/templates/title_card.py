from manim import *
from .base import TimedScene

class TitleCard(TimedScene):
    def __init__(self, *args, title="Algorithm", subtitle="", **kwargs):
        self.title = title
        self.subtitle = subtitle
        super().__init__(*args, **kwargs)

    def construct(self):
        t = Text(self.title, weight=BOLD).scale(1.2)
        sub = Text(self.subtitle).scale(0.7).next_to(t, DOWN)
        g = VGroup(t, sub if self.subtitle else VGroup()).arrange(DOWN, buff=0.4).move_to(ORIGIN)

        self.play(FadeIn(t), run_time=0.5)
        used = 0.5
        if self.subtitle:
            self.play(FadeIn(sub, shift=UP*0.2), run_time=0.4)
            used += 0.4
        self.finish_with_wait(used)
