from manim import Scene, rate_functions
import os

_PACE = float(os.getenv("PACE_MULT", "1.0"))  # e.g. 1.6 to slow everything

class TimedScene(Scene):
    def __init__(self, *args, duration: float = 2.0, **kwargs):
        super().__init__(*args, **kwargs)
        self.duration = float(duration)
        self._elapsed = 0.0

    def _rt(self, t: float) -> float:
        return max(0.01, float(t) * _PACE)

    def step(self, *anims, run_time: float, rate_func=rate_functions.smooth):
        rt = self._rt(run_time)
        self.play(*anims, run_time=rt, rate_func=rate_func)
        self._elapsed += rt

    def finish_with_wait(self, extra_pad: float = 0.0):
        pad = max(0.0, self._rt(self.duration) - self._elapsed + self._rt(extra_pad))
        if pad > 0:
            self.wait(pad)
