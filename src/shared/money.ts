import { DomainError } from "./domain-error";
import { FailureCode } from "./failure-code";

export interface MoneyProps {
  /** Decimal string com exatamente 2 casas, ex.: "25.00". */
  amount: string;
  /** ISO-4217, ex.: "BRL". */
  currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_NON_NEGATIVE_RE = /^(0|[1-9]\d*)\.\d{2}$/;
const AMOUNT_SIGNED_RE = /^-?(0|[1-9]\d*)\.\d{2}$/;

export class InvalidMoneyError extends DomainError {
  readonly failureCode = FailureCode.INVALID_PAYLOAD;
}

export class CurrencyMismatchError extends DomainError {
  readonly failureCode = FailureCode.CURRENCY_MISMATCH;
}

/**
 * Valor monetário imutável. Internamente armazenado em centavos (bigint),
 * então soma e subtração são exatas. Nunca use number/float para dinheiro.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Uso interno (reidratação, deltas de lançamento): aceita negativos. */
  static from(props: MoneyProps): Money {
    return Money.build(props, true);
  }

  /** Entrada externa (API e fila): rejeita negativos. */
  static fromInput(props: MoneyProps): Money {
    return Money.build(props, false);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(0n, currency);
  }

  private static build(props: MoneyProps, allowNegative: boolean): Money {
    if (typeof props?.amount !== "string") {
      throw new InvalidMoneyError("amount deve ser string decimal");
    }
    const re = allowNegative ? AMOUNT_SIGNED_RE : AMOUNT_NON_NEGATIVE_RE;
    if (!re.test(props.amount)) {
      throw new InvalidMoneyError(`amount inválido: "${props.amount}"`);
    }
    assertCurrency(props.currency);
    return new Money(parseMinor(props.amount), props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: formatMinor(this.minor), currency: this.currency };
  }

  toString(): string {
    return `${formatMinor(this.minor)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`moedas diferentes: ${this.currency} x ${other.currency}`);
    }
  }
}

function assertCurrency(currency: string): void {
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
    throw new InvalidMoneyError(`moeda inválida: "${String(currency)}"`);
  }
}

function parseMinor(amount: string): bigint {
  const negative = amount.startsWith("-");
  const body = negative ? amount.slice(1) : amount;
  const [intPart = "0", fracPart = "00"] = body.split(".");
  const value = BigInt(intPart) * 100n + BigInt(fracPart);
  return negative ? -value : value;
}

function formatMinor(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
