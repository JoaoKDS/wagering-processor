import { describe, expect, test } from "bun:test";
import { Metrics } from "../../src/shared/metrics";

describe("Metrics", () => {
  test("contador com labels é separado por combinação de labels", () => {
    const m = new Metrics();
    m.inc("wager_transactions_total", { status: "PROCESSED" });
    m.inc("wager_transactions_total", { status: "PROCESSED" });
    m.inc("wager_transactions_total", { status: "REJECTED" });
    expect(m.get("wager_transactions_total", { status: "PROCESSED" })).toBe(2);
    expect(m.get("wager_transactions_total", { status: "REJECTED" })).toBe(1);
  });

  test("labels na mesma ordem em qualquer objeto geram a mesma série", () => {
    const m = new Metrics();
    m.inc("x", { a: "1", b: "2" });
    m.inc("x", { b: "2", a: "1" });
    expect(m.get("x", { a: "1", b: "2" })).toBe(2);
  });

  test("observação guarda contagem, soma e máximo", () => {
    const m = new Metrics();
    m.observe("wallet_lock_wait_ms", 5);
    m.observe("wallet_lock_wait_ms", 12);
    const text = m.toPrometheus();
    expect(text).toContain("wallet_lock_wait_ms_count 2");
    expect(text).toContain("wallet_lock_wait_ms_sum 17");
    expect(text).toContain("wallet_lock_wait_ms_max 12");
  });

  test("saída em formato texto do Prometheus, com labels nas linhas", () => {
    const m = new Metrics();
    m.inc("outbox_published_total", { event_type: "WalletBalanceChanged" }, 3);
    expect(m.toPrometheus()).toContain('outbox_published_total{event_type="WalletBalanceChanged"} 3');
  });
});
