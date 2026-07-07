// Browser lobby (MVP scope): nickname + room code only, no master-server
// profile/auth (that's a later P2 concern — see docs/p2-port-notes.md
// section 4 for the full Godot-era flow this intentionally simplifies).
//
// ---------------------------------------------------------------------
// HAND-OFF CONTRACT with the game client (src/main.ts, owned separately):
//   - Nickname is stored in `localStorage["sk-nick"]` (plain string, already
//     validated: 2-16 chars, [A-Za-z0-9_-]). The game reads it from there;
//     this lobby never passes it as a URL param.
//   - Room code is passed as a query param on navigation to the game:
//       `/?room=<CODE>` (6 uppercase chars from ROOM_CODE_CHARSET).
//     The game client is responsible for reading `?room=` and driving
//     Colyseus connection/room join — not implemented here.
//   - This lobby does NOT talk to any server (no /api/rooms calls) at MVP
//     scope. "Create room" only generates a client-side code for a
//     friends-style invite link; whether/how that code is registered with
//     a real room server happens on the game-client side, out of scope
//     for this page.
// ---------------------------------------------------------------------
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "./roomCode";
import { validateNick } from "./nick";

const NICK_STORAGE_KEY = "sk-nick";

type ScreenId = "screen-splash" | "screen-nick" | "screen-home" | "screen-room";

function showScreen(id: ScreenId): void {
  for (const el of document.querySelectorAll<HTMLElement>(".screen")) {
    el.classList.toggle("active", el.id === id);
  }
}

function getStoredNick(): string | null {
  return localStorage.getItem(NICK_STORAGE_KEY);
}

function setStoredNick(nick: string): void {
  localStorage.setItem(NICK_STORAGE_KEY, nick);
}

function clearStoredNick(): void {
  localStorage.removeItem(NICK_STORAGE_KEY);
}

function goHomeOrNick(): void {
  const nick = getStoredNick();
  if (nick) {
    renderHome(nick);
    showScreen("screen-home");
  } else {
    showScreen("screen-nick");
  }
}

// --- Splash -----------------------------------------------------------

function initSplash(): void {
  const splash = document.getElementById("screen-splash")!;
  let advanced = false;
  const advance = (): void => {
    if (advanced) return;
    advanced = true;
    goHomeOrNick();
  };
  splash.addEventListener("click", advance);
  setTimeout(advance, 1000);
}

// --- Nick entry ---------------------------------------------------------

function initNickScreen(): void {
  const input = document.getElementById("nick-input") as HTMLInputElement;
  const error = document.getElementById("nick-error")!;
  const playBtn = document.getElementById("btn-play") as HTMLButtonElement;

  const submit = (): void => {
    const result = validateNick(input.value);
    if (!result.valid) {
      error.textContent = result.error ?? "Invalid nickname";
      return;
    }
    error.textContent = "";
    setStoredNick(input.value.trim());
    renderHome(input.value.trim());
    showScreen("screen-home");
  };

  playBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// --- Home ---------------------------------------------------------------

function renderHome(nick: string): void {
  document.getElementById("home-nick")!.textContent = nick;
  // Clear any stale join-code input/error from a previous visit.
  const joinInput = document.getElementById("join-code-input") as HTMLInputElement;
  joinInput.value = "";
  document.getElementById("join-error")!.textContent = "";
}

function initHomeScreen(): void {
  const changeBtn = document.getElementById("btn-change-nick")!;
  const createBtn = document.getElementById("btn-create-room")!;
  const joinBtn = document.getElementById("btn-join-room") as HTMLButtonElement;
  const joinInput = document.getElementById("join-code-input") as HTMLInputElement;
  const joinError = document.getElementById("join-error")!;

  changeBtn.addEventListener("click", () => {
    clearStoredNick();
    const nickInput = document.getElementById("nick-input") as HTMLInputElement;
    nickInput.value = "";
    document.getElementById("nick-error")!.textContent = "";
    showScreen("screen-nick");
    nickInput.focus();
  });

  createBtn.addEventListener("click", () => {
    const code = generateRoomCode();
    renderRoomScreen(code, "created");
    showScreen("screen-room");
  });

  const submitJoin = (): void => {
    const raw = joinInput.value;
    if (!isValidRoomCode(raw)) {
      joinError.textContent = "Enter a valid 6-character room code";
      return;
    }
    joinError.textContent = "";
    const code = normalizeRoomCode(raw);
    renderRoomScreen(code, "joined");
    showScreen("screen-room");
  };

  joinBtn.addEventListener("click", submitJoin);
  joinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitJoin();
  });
}

// --- Room hand-off --------------------------------------------------------

function buildInviteLink(code: string): string {
  return `${location.origin}/?room=${code}`;
}

function buildGameUrl(code: string): string {
  return `/?room=${code}`;
}

/** Copies `text` to the clipboard, falling back to a hidden-textarea trick
 * when the async Clipboard API is unavailable (e.g. LAN http:// dev server
 * is not a secure context, see .claude/skills/web-slice-workflow — LAN IP
 * testing gotcha). Returns whether the copy is believed to have worked. */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy fallback
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function renderRoomScreen(code: string, mode: "created" | "joined"): void {
  document.getElementById("room-title")!.textContent =
    mode === "created" ? "Room Created" : "Joining Room";
  document.getElementById("room-code-display")!.textContent = code;
  document.getElementById("copy-feedback")!.textContent = "";
  const goBtn = document.getElementById("btn-go") as HTMLButtonElement;
  goBtn.dataset.roomCode = code;
}

function initRoomScreen(): void {
  const copyBtn = document.getElementById("btn-copy-link") as HTMLButtonElement;
  const copyFeedback = document.getElementById("copy-feedback")!;
  const goBtn = document.getElementById("btn-go") as HTMLButtonElement;
  const backBtn = document.getElementById("btn-back-home")!;

  copyBtn.addEventListener("click", () => {
    const code = document.getElementById("room-code-display")!.textContent ?? "";
    void copyToClipboard(buildInviteLink(code)).then((ok) => {
      copyFeedback.textContent = ok ? "Link copied!" : "Copy failed — select and copy manually";
    });
  });

  goBtn.addEventListener("click", () => {
    const code = goBtn.dataset.roomCode ?? document.getElementById("room-code-display")!.textContent ?? "";
    location.href = buildGameUrl(code);
  });

  backBtn.addEventListener("click", () => {
    const nick = getStoredNick();
    if (nick) renderHome(nick);
    showScreen("screen-home");
  });
}

function init(): void {
  initSplash();
  initNickScreen();
  initHomeScreen();
  initRoomScreen();
}

init();
