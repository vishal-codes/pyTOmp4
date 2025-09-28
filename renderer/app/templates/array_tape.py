from manim import *
from .base import TimedScene

COLOR = {"left": BLUE, "mid": PURPLE, "right": RED}

class ArrayTape(TimedScene):
    def __init__(self, *args, values=None, pointers=None, highlight=None, **kwargs):
        # values: list[int], pointers: {"left":i,"mid":j,"right":k}
        self.values   = list(values or [])
        self.pointers = dict(pointers or {})
        self.highlight = set(highlight or [])
        super().__init__(*args, **kwargs)

    def construct(self):
        n = len(self.values)
        if n == 0:
            self.finish_with_wait(); return

        # ---- time budgeting (scaled again by PACE_MULT in TimedScene) ----
        # Keep the classic look but give each phase enough time.
        weights = dict(draw=0.55, labels=0.35, arrows=0.70, pad=0.20)
        total_w = sum(weights.values())
        budget  = max(0.8, self.duration - 0.05)   # small margin so muxing never chops frames
        s = budget / total_w

        # ---- lay out cells ----
        cell_w = min(1.2, 9.5 / max(1, n))
        cells, labels = VGroup(), VGroup()
        for i, v in enumerate(self.values):
            r = Rectangle(width=cell_w, height=0.9)
            if i in self.highlight:
                r.set_stroke(YELLOW, width=5)
            t = Text(str(v)).scale(0.5); t.move_to(r.get_center())
            cells.add(VGroup(r, t))
            labels.add(Text(str(i)).scale(0.35))

        cells.arrange(RIGHT, buff=0.1).move_to(ORIGIN)
        for i, lab in enumerate(labels):
            lab.next_to(cells[i], DOWN*0.8)

        # draw tape + values + indices
        self.step(*(Create(c[0]) for c in cells), run_time=weights["draw"]*s)
        self.step(*(FadeIn(c[1]) for c in cells), run_time=0.30*s)
        self.step(*[FadeIn(l, shift=DOWN*0.1) for l in labels], run_time=weights["labels"]*s)

        # ---- build arrows; avoid overlap when multiple pointers share an index ----
        # Group by target index
        by_idx = {}
        for name, idx in self.pointers.items():
            if isinstance(idx, int) and 0 <= idx < n:
                by_idx.setdefault(idx, []).append(name)

        arrow_anims, tag_anims = [], []
        base_up = 0.8   # base height above the cell
        # For each index, offset arrows slightly in X and Y so they never overlap
        for idx, names in by_idx.items():
            # stable order helps: left, mid, right
            names = [k for k in ("left","mid","right") if k in names]
            k = len(names)
            # horizontal offsets for 1/2/3 stacked arrows
            if k == 1:
                xoffs = [0.0]
            elif k == 2:
                xoffs = [-0.25*cell_w, +0.25*cell_w]
            else:  # 3
                xoffs = [-0.35*cell_w, 0.0, +0.35*cell_w]
            # small vertical jitter too for clarity
            yoffs = {1:[0.00], 2:[-0.12,+0.12], 3:[-0.18,0.0,+0.18]}[min(k,3)]

            for name, dx, dy in zip(names, xoffs, yoffs):
                col = COLOR.get(name, GREEN)
                arr = Arrow(start=UP*(1.2+dy), end=ORIGIN, buff=0).set_color(col).scale(0.6)
                arr.next_to(cells[idx], UP*(base_up+dy))
                arr.shift(RIGHT*dx)
                tag = Text(name).scale(0.40).set_color(col).next_to(arr, UP*0.25)
                arrow_anims.append(GrowArrow(arr))
                tag_anims.append(FadeIn(tag, shift=UP*0.1))

        if arrow_anims or tag_anims:
            self.step(*arrow_anims, *tag_anims, run_time=max(0.35, weights["arrows"]*s))

        # Finish to match audio (or extend slightly in local debug)
        self.finish_with_wait(extra_pad=weights["pad"]*s)
