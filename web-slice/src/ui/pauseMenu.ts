// ESC pause menu: CONTINUE / QUIT TO LOBBY. Neon Stadium palette
// (docs/p2-port-notes.md: BG_DEEP #0C0F1F, BG_BUTTON #293666, ACCENT_GOLD
// #FFD633 for hover/focus). Mounted by src/combat/index.ts createCombat()
// rather than main.ts — main.ts stays a thin boot file per the architectural
// invariant in .claude/skills/web-slice-workflow/SKILL.md.
//
// This is NOT a real pause: the game is multiplayer and keeps simulating
// (physics tick, other players' karts, the match timer) while the menu is
// open — it's just a modal-looking overlay on top of a still-live game, same
// as FinalScoreOverlay. "Continue" and a second ESC press both just hide it.
//
// Owns its own keydown listener for Escape. src/core/input.ts's listeners
// only ever look at KeyW/KeyA/KeyS/KeyD/Space and mousedown — Escape is
// untouched there, so this doesn't shadow or conflict with anything.
export function mountPauseMenu(): void {
  const rootEl = document.createElement("div");
  rootEl.id = "pause-menu";
  Object.assign(rootEl.style, {
    position: "fixed", inset: "0", zIndex: "40",
    display: "none", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: "18px",
    background: "rgba(12, 15, 31, 0.85)", // Neon Stadium BG_DEEP
    font: "16px/1.5 monospace",
  } satisfies Partial<CSSStyleDeclaration>);

  const title = document.createElement("div");
  title.textContent = "PAUSED";
  Object.assign(title.style, {
    font: "bold 32px/1.2 monospace", color: "#4CEBFF", // ACCENT_CYAN
    textShadow: "0 0 10px #4CEBFF88", marginBottom: "12px", letterSpacing: "3px",
  } satisfies Partial<CSSStyleDeclaration>);
  rootEl.appendChild(title);

  const continueBtn = makeButton("CONTINUE");
  const quitBtn = makeButton("QUIT TO LOBBY");
  rootEl.appendChild(continueBtn);
  rootEl.appendChild(quitBtn);
  document.body.appendChild(rootEl);

  function setOpen(open: boolean): void {
    rootEl.style.display = open ? "flex" : "none";
  }

  continueBtn.addEventListener("click", () => setOpen(false));
  quitBtn.addEventListener("click", () => {
    location.href = "/lobby.html";
  });

  addEventListener("keydown", e => {
    if (e.code !== "Escape") return;
    const isOpen = rootEl.style.display === "flex";
    setOpen(!isOpen);
  });
}

function makeButton(label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  Object.assign(btn.style, {
    font: "bold 18px/1.4 monospace", color: "#F5FAFF", // TEXT_PRIMARY
    background: "#293666", // BG_BUTTON
    border: "1px solid #4CDBFF88", // BORDER_NORMAL
    borderRadius: "10px", padding: "14px 28px", cursor: "pointer",
    minWidth: "220px", letterSpacing: "1px",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.addEventListener("mouseenter", () => { btn.style.color = "#FFD633"; }); // ACCENT_GOLD hover
  btn.addEventListener("mouseleave", () => { btn.style.color = "#F5FAFF"; });
  return btn;
}
