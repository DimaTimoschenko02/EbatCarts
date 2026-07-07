// Room code rules mirror the master server's generator exactly
// (server/rooms/rooms.constants.js: ROOM_CODE_CHARSET/ROOM_CODE_LEN) so a
// client-generated code always looks/behaves the same as a server-issued one.
// Charset intentionally excludes confusable glyphs (0/O, 1/I).
export const ROOM_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LEN = 6;

/** Generates a random room code using the shared charset/length. */
export function generateRoomCode(): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return out;
}

/** Trims whitespace and uppercases — the shape a user typically types a code in. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

/** True if `input` (after normalization) is a well-formed room code. */
export function isValidRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input);
  if (code.length !== ROOM_CODE_LEN) return false;
  for (const ch of code) {
    if (!ROOM_CODE_CHARSET.includes(ch)) return false;
  }
  return true;
}
