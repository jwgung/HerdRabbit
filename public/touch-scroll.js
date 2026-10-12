// A finger drag on the terminal, turned into the wheel notches herdr scrolls
// by. herdr moves a few lines per notch however far a wheel turned, so the
// finger's distance is counted out in notches: the history follows the finger
// instead of jumping once per touch event. Let go while moving and it keeps
// going, slowing down, the way a phone scrolls anything else.

// How fast the glide slows: the share of speed kept each millisecond.
const FRICTION_PER_MS = 0.996;
// Below this the glide stops (pixels per millisecond).
const STOP_SPEED = 0.02;
// Only the movement this recent decides how fast the glide starts.
const VELOCITY_WINDOW_MS = 100;

// `step()` is the finger distance of one notch in pixels; `emit(direction)`
// sends one notch (positive scrolls toward older lines' opposite, as a wheel's
// deltaY does); `frame(callback)` and `cancelFrame(id)` schedule the glide.
export function createTouchScroller({ step, emit, frame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id), now = () => performance.now() }) {
  let lastY = null;
  let pending = 0;
  let samples = [];
  let glide = null;

  function stopGlide() {
    if (glide) cancelFrame(glide.frame);
    glide = null;
  }

  // Sends as many whole notches as the distance so far holds; the rest waits.
  function spend(distance) {
    pending += distance;
    const size = Math.max(1, step());
    while (Math.abs(pending) >= size) {
      const direction = Math.sign(pending);
      emit(direction);
      pending -= direction * size;
    }
  }

  return {
    start(y) {
      stopGlide();
      lastY = y;
      pending = 0;
      samples = [{ y, time: now() }];
    },

    move(y) {
      if (lastY === null) return;
      // A finger moving down shows older lines: a wheel turned up, negative deltaY.
      spend(lastY - y);
      lastY = y;
      const time = now();
      samples.push({ y, time });
      samples = samples.filter((sample) => time - sample.time <= VELOCITY_WINDOW_MS);
    },

    end() {
      if (lastY === null) return;
      lastY = null;
      const first = samples[0];
      const last = samples.at(-1);
      const elapsed = last && first ? last.time - first.time : 0;
      // A finger that stopped before lifting does not glide.
      if (!elapsed || now() - last.time > VELOCITY_WINDOW_MS) return;
      let velocity = (first.y - last.y) / elapsed;
      if (Math.abs(velocity) < STOP_SPEED) return;
      let previous = now();
      const tick = () => {
        const time = now();
        const elapsedTick = time - previous;
        previous = time;
        spend(velocity * elapsedTick);
        velocity *= FRICTION_PER_MS ** elapsedTick;
        if (Math.abs(velocity) < STOP_SPEED) { glide = null; return; }
        glide.frame = frame(tick);
      };
      glide = { frame: frame(tick) };
    },

    // Another touch, a pinch, or the pane going away stops everything.
    cancel() {
      stopGlide();
      lastY = null;
      pending = 0;
    },
  };
}
