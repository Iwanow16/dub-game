import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("navigator", { language: "ru-RU" });

const { format } = await import("./i18n.ts");

describe("i18n format", () => {
  it("substitutes params and handles Russian plurals", () => {
    const tpl = "{n, plural, one {# зритель} few {# зрителя} many {# зрителей} other {# зрителя}}";
    expect(format("ru", tpl, { n: 1 })).toBe("1 зритель");
    expect(format("ru", tpl, { n: 3 })).toBe("3 зрителя");
    expect(format("ru", tpl, { n: 11 })).toBe("11 зрителей");
    expect(format("ru", tpl, { n: 22 })).toBe("22 зрителя");
    expect(format("en", "{n, plural, one {# vote} other {# votes}}", { n: 2 })).toBe("2 votes");
    expect(format("ru", "Раунд {r}/{total}", { r: 2, total: 5 })).toBe("Раунд 2/5");
  });
});
