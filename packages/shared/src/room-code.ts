/** Room codes: 5 characters, no look-alikes (no 0/O, 1/I/L) — US-2. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(randomInt: (max: number) => number): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Accepts user input like " k7qx2 " and returns the canonical code or null. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  if (code.length < 4 || code.length > 6) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
