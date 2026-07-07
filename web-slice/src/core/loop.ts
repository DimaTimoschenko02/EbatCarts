// Fixed-step simulation clock. Physics runs on setInterval with fixed
// substeps (NOT rAF): Chrome fully suspends rAF for occluded windows, which
// breaks agent-driven testing. Scripted runs burn SIM time so they are
// deterministic at any render fps. See src/main.ts for how this is wired to
// both a setInterval tick (keeps simulating in background tabs) and a rAF
// tick (keeps input latency low while the tab is visible).
export class FixedStepLoop {
  private prev = performance.now();
  private acc = 0;

  constructor(
    private readonly stepSeconds: number,
    private readonly maxCatchupSeconds: number
  ) {}

  // Runs `substep(dt)` as many times as needed to catch up to real elapsed
  // time since the last tick() call (clamped to maxCatchupSeconds so a
  // long stall — tab backgrounded, debugger paused — doesn't spiral).
  tick(substep: (dt: number) => void): void {
    const now = performance.now();
    this.acc += Math.min((now - this.prev) / 1000, this.maxCatchupSeconds);
    this.prev = now;
    while (this.acc >= this.stepSeconds) {
      substep(this.stepSeconds);
      this.acc -= this.stepSeconds;
    }
  }
}
