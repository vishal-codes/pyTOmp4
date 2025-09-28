from manim import *
from .base import TimedScene

COLOR = {"left": BLUE, "mid": PURPLE, "right": RED}

class MovePointer(TimedScene):
    def __init__(self, *args, values=None, which="left", frm=None, to=None, **kwargs):
        self.values = list(values or [])
        self.which  = which
        self.frm    = frm
        self.to     = to
        super().__init__(*args, **kwargs)

    def construct(self):
        n = len(self.values)
        if n == 0 or self.frm is None or self.to is None:
            self.finish_with_wait(); return

        # ---- time budgeting ----
        weights = dict(draw=0.25, labels=0.15, show=0.20, slide=0.65, pad=0.15)
        total_w = sum(weights.values())
        budget = max(0.6, self.duration - 0.05)
        s = budget / total_w

        cell_w = min(1.2, 9.5 / max(1, n))
        cells = VGroup()
        for v in self.values:
            r = Rectangle(width=cell_w, height=0.9)
            t = Text(str(v)).scale(0.5); t.move_to(r.get_center())
            cells.add(VGroup(r, t))
        cells.arrange(RIGHT, buff=0.1).move_to(ORIGIN)

        col = COLOR.get(self.which, GREEN)
        arr = Arrow(start=UP*1.2, end=ORIGIN, buff=0).set_color(col).scale(0.6)
        arr.next_to(cells[self.frm], UP*0.8)
        tag = Text(self.which).scale(0.4).set_color(col).next_to(arr, UP*0.25)

        self.step(*(Create(c[0]) for c in cells), run_time=weights["draw"]*s)
        self.step(*(FadeIn(c[1]) for c in cells), run_time=weights["labels"]*s)
        self.step(FadeIn(arr), FadeIn(tag), run_time=weights["show"]*s)

        tgt = cells[self.to].get_center() + UP*1.2
        self.step(arr.animate.move_to(tgt), tag.animate.next_to(arr, UP*0.25),
                  run_time=max(0.25, weights["slide"]*s))

        self.finish_with_wait(extra_pad=weights["pad"]*s)
