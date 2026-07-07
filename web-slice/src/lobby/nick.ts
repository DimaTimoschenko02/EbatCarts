// MVP nickname rule for the browser lobby. Deliberately narrower than the
// Godot-era master-server profile system (2-20 chars, docs/p2-port-notes.md
// section 4) — this lobby has no server-side profile/auth step at all yet,
// it is purely a local nickname used as a display name handed off to the
// game client via localStorage. Range/charset chosen per this task's brief.
export const NICK_MIN_LEN = 2;
export const NICK_MAX_LEN = 16;
const NICK_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface NickValidation {
  readonly valid: boolean;
  readonly error?: string;
}

/** Validates a raw (untrimmed) nickname string for the lobby nick screen. */
export function validateNick(raw: string): NickValidation {
  const nick = raw.trim();
  if (nick.length < NICK_MIN_LEN || nick.length > NICK_MAX_LEN) {
    return { valid: false, error: `${NICK_MIN_LEN}-${NICK_MAX_LEN} characters` };
  }
  if (!NICK_PATTERN.test(nick)) {
    return { valid: false, error: "Letters, numbers, _ and - only" };
  }
  return { valid: true };
}
