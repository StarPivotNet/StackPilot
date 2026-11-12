import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Bar, Sparkline } from "./StatusVisuals";

describe("unavailable resource measurements", () => {
  it("labels an absent series instead of presenting a zero measurement", () => {
    const { container, rerender } = render(<Sparkline values={[]} />);
    expect(screen.getByText("暂无采集数据")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    rerender(<Sparkline values={[0]} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("keeps a collected zero distinct from an unavailable percentage", () => {
    const { container, rerender } = render(<Bar value="—" tone="blue" />);
    expect(container.querySelector(".bar-cell")).toBeNull();
    rerender(<Bar value="0%" tone="blue" />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(container.querySelector(".bar-cell i b")).toHaveStyle({ width: "0%" });
  });
});
