import { describe, expect, it } from "vitest";
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, ROOM_CODE_CHARSET, ROOM_CODE_LEN } from "./roomCode";

describe("roomCode", () => {
  it("generateRoomCode produces a code of the expected length/charset", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code.length).toBe(ROOM_CODE_LEN);
      for (const ch of code) {
        expect(ROOM_CODE_CHARSET.includes(ch)).toBe(true);
      }
    }
  });

  it("normalizeRoomCode trims and uppercases", () => {
    expect(normalizeRoomCode("  ab12cd  ")).toBe("AB12CD");
  });

  it("isValidRoomCode accepts well-formed codes, case-insensitively", () => {
    expect(isValidRoomCode("AB2CDE")).toBe(true);
    expect(isValidRoomCode("ab2cde")).toBe(true);
    expect(isValidRoomCode(" AB2CDE ")).toBe(true);
  });

  it("isValidRoomCode rejects wrong length", () => {
    expect(isValidRoomCode("AB2CD")).toBe(false);
    expect(isValidRoomCode("AB2CDEF")).toBe(false);
    expect(isValidRoomCode("")).toBe(false);
  });

  it("isValidRoomCode rejects confusable/invalid characters", () => {
    expect(isValidRoomCode("AB0CDE")).toBe(false); // 0 excluded
    expect(isValidRoomCode("ABOCDE")).toBe(false); // O excluded
    expect(isValidRoomCode("AB1CDE")).toBe(false); // 1 excluded
    expect(isValidRoomCode("ABICDE")).toBe(false); // I excluded
    expect(isValidRoomCode("AB-CDE")).toBe(false); // punctuation
  });
});
