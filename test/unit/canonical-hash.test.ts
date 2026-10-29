import { describe, expect, test } from "bun:test";
import { canonicalHash, canonicalJson } from "../../src/shared/canonical-hash";

describe("canonicalJson", () => {
  test("ordena chaves recursivamente", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("remove valores undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("preserva ordem de arrays", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("canonicalHash", () => {
  test("mesmo conteúdo com ordem diferente gera o mesmo hash", () => {
    expect(canonicalHash({ x: 1, y: { p: "a", q: "b" } })).toBe(canonicalHash({ y: { q: "b", p: "a" }, x: 1 }));
  });

  test("conteúdo diferente gera hash diferente", () => {
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }));
  });

  test("é SHA-256 em hex (64 caracteres)", () => {
    expect(canonicalHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
