import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "../../src/shared/money";

const brl = (amount: string) => Money.fromInput({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializa sempre com exatamente 2 casas decimais", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("0.50").toJSON().amount).toBe("0.50");
    expect(Money.from({ amount: "-0.50", currency: "BRL" }).toJSON().amount).toBe("-0.50");
  });

  test("soma e subtração são exatas (0.10 + 0.20 = 0.30, sem erro de float)", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
  });

  test("subtração pode produzir negativo internamente (usado em deltas de lançamento)", () => {
    const result = brl("10.00").subtract(brl("25.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-15.00");
  });

  test.each(["NaN", "Infinity", "-Infinity", "1e3", "1E3", "", "abc", "1.234", "1.5", "25", "01.00", " 1.00", "1.00 "])(
    "rejeita entrada inválida %p",
    (amount) => {
      expect(() => Money.fromInput({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    },
  );

  test("rejeita valor negativo em entrada externa", () => {
    expect(() => Money.fromInput({ amount: "-1.00", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string", () => {
    // @ts-expect-error validando contrato em runtime
    expect(() => Money.fromInput({ amount: 25, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejeita moeda fora do formato ISO-4217 de 3 letras maiúsculas", () => {
    expect(() => Money.fromInput({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
    expect(() => Money.fromInput({ amount: "1.00", currency: "BRLL" })).toThrow(InvalidMoneyError);
  });

  test("operações entre moedas diferentes lançam erro de domínio", () => {
    const usd = Money.zero("USD");
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("é imutável: operações devolvem nova instância e não alteram o original", () => {
    const a = brl("1.00");
    const b = a.add(brl("2.00"));
    expect(a.toJSON().amount).toBe("1.00");
    expect(b).not.toBe(a);
    expect(b.toJSON().amount).toBe("3.00");
  });

  test("predicados de sinal e comparação", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("1.00").negate().isNegative()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
  });

  test("equals considera valor e moeda", () => {
    expect(brl("5.00").equals(brl("5.00"))).toBe(true);
    expect(brl("5.00").equals(brl("5.01"))).toBe(false);
    expect(Money.zero("BRL").equals(Money.zero("USD"))).toBe(false);
  });

  test("toString formata com moeda", () => {
    expect(brl("975.00").toString()).toBe("975.00 BRL");
  });
});
