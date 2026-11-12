import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOverview } from "../api/overviewApi";
import { OverviewPage } from "../pages/OverviewPage";

vi.mock("../api/overviewApi", () => ({
  checkOverviewUpdates: vi.fn(),
  fetchOverview: vi.fn(),
}));

describe("overview page layout", () => {
  beforeEach(() => {
    vi.mocked(fetchOverview).mockReset();
  });

  it("shows the designed heading and navigation without inventing unavailable metrics", () => {
    vi.mocked(fetchOverview).mockReturnValue(new Promise(() => undefined));

    const { container } = render(<OverviewPage setPage={vi.fn()} notify={vi.fn()} />);
    const heading = screen.getByRole("heading", { name: "工作台" });
    const page = heading.closest(".overview-page");

    expect(heading).not.toHaveClass("sr-only");
    expect(page).toContainElement(screen.getByRole("navigation", { name: "总览页面" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在采集工作台数据");
    expect(container.querySelectorAll(".metric-card")).toHaveLength(0);
    expect(container.querySelector(".progress-score")).not.toBeInTheDocument();
  });
});
