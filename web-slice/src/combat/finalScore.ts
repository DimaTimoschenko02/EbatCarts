// Full-screen "MATCH OVER" scoreboard overlay, shown between
// server/rooms/MatchRoom.ts endMatch() ("match:end") and restartMatch()
// ("match:restart"). Plain DOM, Neon Stadium palette (docs/p2-port-notes.md:
// BG_DEEP #0C0F1F, ACCENT_CYAN #4CEBFF, ACCENT_GOLD #FFD633).
//
// Deliberately does NOT block input: karts keep driving during the freeze
// (fire is already server-disabled during phase="ended", see MatchRoom.ts
// tickBoxes/applyDamage/handleFire guards) — this overlay is read-only UI on
// top of a still-live scene, not a modal that pauses anything.
import type { ScoreboardRow } from "../net/netClient";

const RESTART_TICK_MS = 250;

export class FinalScoreOverlay {
  private restartAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly rootEl: HTMLElement,
    private readonly tableEl: HTMLElement,
    private readonly countdownEl: HTMLElement
  ) {}

  static mount(): FinalScoreOverlay {
    const rootEl = document.createElement("div");
    rootEl.id = "final-score-overlay";
    Object.assign(rootEl.style, {
      position: "fixed", inset: "0", zIndex: "30",
      display: "none", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "rgba(12, 15, 31, 0.92)", // Neon Stadium BG_DEEP, near-opaque
      font: "16px/1.5 monospace", color: "#F5FAFF", // TEXT_PRIMARY
      pointerEvents: "none", // read-only overlay, see file header
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement("div");
    title.textContent = "MATCH OVER";
    Object.assign(title.style, {
      font: "bold 40px/1.2 monospace", color: "#4CEBFF", // ACCENT_CYAN
      textShadow: "0 0 12px #4CEBFF88", marginBottom: "24px", letterSpacing: "4px",
    } satisfies Partial<CSSStyleDeclaration>);
    rootEl.appendChild(title);

    const tableEl = document.createElement("div");
    Object.assign(tableEl.style, {
      whiteSpace: "pre", font: "18px/1.6 monospace", marginBottom: "28px",
      background: "rgba(29, 33, 62, 0.7)", // BG_PANEL
      border: "1px solid #4CDBFF88", // BORDER_NORMAL
      borderRadius: "18px", padding: "24px 36px",
    } satisfies Partial<CSSStyleDeclaration>);
    rootEl.appendChild(tableEl);

    const countdownEl = document.createElement("div");
    Object.assign(countdownEl.style, {
      font: "bold 18px/1.4 monospace", color: "#FFD633", // ACCENT_GOLD
    } satisfies Partial<CSSStyleDeclaration>);
    rootEl.appendChild(countdownEl);

    document.body.appendChild(rootEl);
    return new FinalScoreOverlay(rootEl, tableEl, countdownEl);
  }

  show(table: ScoreboardRow[], restartAt: number): void {
    this.restartAt = restartAt;
    const sorted = [...table].sort((a, b) => b.kills - a.kills);
    const rows = sorted.map(r => `${r.nick.padEnd(20)} K:${r.kills}  D:${r.deaths}`);
    this.tableEl.textContent = rows.length > 0 ? rows.join("\n") : "(no players)";
    this.rootEl.style.display = "flex";
    this.tick();
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.tick(), RESTART_TICK_MS);
    }
  }

  hide(): void {
    this.rootEl.style.display = "none";
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const remainingS = Math.max(0, Math.ceil((this.restartAt - Date.now()) / 1000));
    this.countdownEl.textContent = `Next match in ${remainingS}…`;
  }
}
