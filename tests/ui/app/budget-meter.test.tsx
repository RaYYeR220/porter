// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetMeter, budgetMath } from "../../../components/app/BudgetMeter";
import { resetText, usd } from "../../../components/app/format";

const NOW = Date.parse("2026-11-08T20:48:00.000Z");
const RESET = "2026-11-09T00:00:00.000Z";

describe("budgetMath", () => {
  it("is spend over the cap, with the tier-down line at 80% and the cap at 100%", () => {
    expect(budgetMath(0.0125, 0.05)).toEqual({ pct: 25, fill: 25, state: "ok" });
    expect(budgetMath(0.04, 0.05).state).toBe("tier");
    expect(budgetMath(0.0399, 0.05).state).toBe("ok");
    expect(budgetMath(0.05, 0.05).state).toBe("capped");
  });

  it("never draws past the end, but keeps the real percentage", () => {
    const m = budgetMath(0.06, 0.05);
    expect(m.fill).toBe(100);
    expect(m.pct).toBeCloseTo(120);
    expect(m.state).toBe("capped");
  });

  it("gives no percentage when the cap is unknown or zero", () => {
    expect(budgetMath(0.01, null)).toEqual({ pct: null, fill: 0, state: "unknown" });
    expect(budgetMath(0.01, 0).state).toBe("unknown");
    expect(budgetMath(Number.NaN, 0.05).state).toBe("unknown");
  });
});

describe("reset text", () => {
  it("counts down to the gateway's reset time", () => {
    expect(resetText(RESET, NOW)).toBe("resets in 3 h 12 min");
    expect(resetText("2026-11-08T20:48:20.000Z", NOW)).toBe("resets in 1 min");
    expect(resetText("2026-11-08T20:00:00.000Z", NOW)).toBe("resets now");
    expect(resetText(null, NOW)).toBe("—");
  });
});

describe("BudgetMeter", () => {
  afterEach(cleanup);

  it("shows spend of cap, the percentage and the reset, and exposes them to assistive tech", () => {
    const { container } = render(<BudgetMeter spendUsd={0.0125} limitUsd={0.05} nextResetAt={RESET} now={NOW} label="Budget used" />);
    const meter = screen.getByRole("meter", { name: "Budget used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(meter.getAttribute("aria-valuetext")).toBe("$0.0125 of $0.05 spent, 25%, resets in 3 h 12 min");
    expect(container.textContent).toContain("resets in 3 h 12 min");
    expect(container.textContent).toContain("Under the tier-down line");
    expect((container.querySelector(".meter-fill") as HTMLElement).style.width).toBe("25%");
  });

  it("says when the author is past the tier-down line and when the gateway refuses", () => {
    const tier = render(<BudgetMeter spendUsd={0.042} limitUsd={0.05} nextResetAt={RESET} now={NOW} />);
    expect(tier.container.textContent).toContain("Past 80%: triage moves to gpt-oss-20b");
    expect(tier.container.querySelector(".meter-tier")).toBeTruthy();
    cleanup();
    const cap = render(<BudgetMeter spendUsd={0.051} limitUsd={0.05} nextResetAt={RESET} now={NOW} />);
    expect(cap.container.textContent).toContain("At the cap: the gateway refuses until the reset");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
  });

  it("shows a dash, not a guess, when no cap is reported", () => {
    const { container } = render(<BudgetMeter spendUsd={0.01} limitUsd={null} nextResetAt={null} now={NOW} />);
    expect(container.querySelector(".meter-pct")?.textContent).toBe("—");
    expect(container.textContent).toContain("No cap reported for this budget");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBeNull();
  });
});

describe("usd", () => {
  it("keeps small costs readable and never invents precision", () => {
    expect(usd(0.0004)).toBe("$0.0004");
    expect(usd(0.05)).toBe("$0.05");
    expect(usd(0.012)).toBe("$0.012");
    expect(usd(1.2)).toBe("$1.20");
    expect(usd(0)).toBe("$0");
    expect(usd(0.00002)).toBe("<$0.0001");
    expect(usd(null)).toBe("—");
  });
});
