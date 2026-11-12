import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopTopbarChrome, navItemsForPermissions, topbarSearchResults } from "../app/navigation";
import { TopBar } from "../components/layout/TopBar";
import { ThemeProvider } from "../theme/ThemeProvider";
import { THEME_STORAGE_KEY, useTheme } from "../theme/theme";

function ThemeHarness() {
  const { theme, toggleTheme } = useTheme();
  return <button type="button" onClick={toggleTheme}>{theme}</button>;
}

describe("theme provider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults invalid or missing storage to light", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    render(<ThemeProvider><ThemeHarness /></ThemeProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores, toggles, and persists a valid theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeProvider><ThemeHarness /></ThemeProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("dark");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("keeps the top-bar theme control available for a partial monitoring response", () => {
    render(
      <ThemeProvider>
        <TopBar
          page="sites-runtime"
          setPage={vi.fn()}
          chrome={{ white: true, showBreadcrumb: true, showCompactSearch: true, showStatus: true, showActivity: true }}
          notify={vi.fn()}
          unreadCount={0}
          setUnreadCount={vi.fn()}
          overview={{ lastRefresh: "" } as never}
          interactionsDisabled={false}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "切换到浅色主题" })).toBeInTheDocument();
  });

  it("keeps the shared CloudPulse breadcrumb on workbench and module pages", () => {
    const { rerender } = render(
      <ThemeProvider>
        <TopBar
          page="overview"
          setPage={vi.fn()}
          chrome={desktopTopbarChrome("overview")}
          notify={vi.fn()}
          unreadCount={0}
          setUnreadCount={vi.fn()}
          overview={null}
          interactionsDisabled={false}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("当前位置")).toHaveTextContent("控制台工作台");
    expect(document.querySelector(".cloud-header")).not.toHaveClass("without-context");

    rerender(
      <ThemeProvider>
        <TopBar
          page="sites-runtime"
          setPage={vi.fn()}
          chrome={desktopTopbarChrome("sites-runtime")}
          notify={vi.fn()}
          unreadCount={0}
          setUnreadCount={vi.fn()}
          overview={null}
          interactionsDisabled={false}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("当前位置")).toHaveTextContent("网站服务分组");
    expect(document.querySelector(".cloud-header")).not.toHaveClass("without-context");

    rerender(
      <ThemeProvider>
        <TopBar
          page="hosts"
          setPage={vi.fn()}
          chrome={desktopTopbarChrome("hosts")}
          notify={vi.fn()}
          unreadCount={0}
          setUnreadCount={vi.fn()}
          overview={null}
          interactionsDisabled={false}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("当前位置")).toHaveTextContent("资源管理主机");
    expect(document.querySelector(".cloud-header")).not.toHaveClass("without-context");
  });

  it("filters protected global-search destinations by permission", () => {
    render(
      <ThemeProvider>
        <TopBar
          page="sites"
          setPage={vi.fn()}
          chrome={desktopTopbarChrome("sites")}
          notify={vi.fn()}
          unreadCount={0}
          setUnreadCount={vi.fn()}
          overview={null}
          interactionsDisabled={false}
          permissions={["sites:read"]}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "全局搜索" }), { target: { value: "部署站点" } });
    expect(screen.getByText("没有匹配结果")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /部署站点/ })).not.toBeInTheDocument();
  });
});

describe("permission-aware audit navigation", () => {
  it("hides audit navigation and quick export without audit:read", () => { expect(navItemsForPermissions([]).some((item) => item.key === "audit")).toBe(false); expect(topbarSearchResults("审计", []).some((item) => item.page === "audit" || item.page === "audit-export")).toBe(false); });
  it("shows audit logs but not persistent exports with audit:read", () => { expect(navItemsForPermissions(["audit:read"]).some((item) => item.key === "audit")).toBe(true); expect(topbarSearchResults("审计", ["audit:read"]).some((item) => item.page === "audit-export")).toBe(false); });
});
