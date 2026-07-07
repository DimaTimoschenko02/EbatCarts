import { describe, expect, it } from "vitest";
import { NICK_MAX_LEN, NICK_MIN_LEN, validateNick } from "./nick";

describe("validateNick", () => {
  it("accepts a normal nickname", () => {
    expect(validateNick("Dima_2").valid).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateNick("  Dima  ").valid).toBe(true);
  });

  it("rejects too short / too long", () => {
    expect(validateNick("a").valid).toBe(false);
    expect(validateNick("a".repeat(NICK_MIN_LEN - 1)).valid).toBe(false);
    expect(validateNick("a".repeat(NICK_MAX_LEN + 1)).valid).toBe(false);
  });

  it("accepts the boundary lengths", () => {
    expect(validateNick("a".repeat(NICK_MIN_LEN)).valid).toBe(true);
    expect(validateNick("a".repeat(NICK_MAX_LEN)).valid).toBe(true);
  });

  it("rejects disallowed characters", () => {
    expect(validateNick("bad name").valid).toBe(false); // space
    expect(validateNick("bad!name").valid).toBe(false); // punctuation
    expect(validateNick("никнейм").valid).toBe(false); // non-ASCII
  });

  it("allows underscores and hyphens", () => {
    expect(validateNick("dima-_kart").valid).toBe(true);
  });
});
