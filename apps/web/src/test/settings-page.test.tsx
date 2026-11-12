import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../pages/SettingsPage";

const renderSettings = (page: string, readOnly = false) => {
  const setPage = vi.fn(), setReadOnly = vi.fn(), notify = vi.fn();
  const result = render(<SettingsPage page={page} setPage={setPage} notify={notify} readOnlyState={{ readOnly, setReadOnly }} permissions={[]} />);
  return { ...result, setPage, setReadOnly, notify };
};
afterEach(() => vi.unstubAllGlobals());
describe("settings workbench", () => {
  it.each([["settings","面板设置"],["settings-general","基础设置"],["settings-security","安全策略"],["settings-notice","通知设置"],["settings-backup","备份策略"],["settings-audit","设置审计"]])("preserves a visible design heading on %s", (page,title) => {
    const { container } = renderSettings(page);
    expect(screen.getByRole("heading",{name:title,level:1})).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });
  it("keeps canonical tabs and a truthful local read-only preference", () => {
    const { setPage, setReadOnly } = renderSettings("settings");
    expect(screen.getByLabelText("当前访问地址")).toHaveValue(window.location.origin);
    fireEvent.click(screen.getByRole("button",{name:"安全"}));
    expect(setPage).toHaveBeenCalledWith("settings-security",{message:"已切换到安全设置",tone:"info"});
    fireEvent.click(screen.getByRole("switch",{name:/^本会话只读模式/}));
    expect(setReadOnly).toHaveBeenCalledWith(true);
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
  });
  it.each(["settings-security","settings-notice"])("does not simulate a saved policy or delivery on %s", (page) => {
    const fetchMock=vi.fn(); vi.stubGlobal("fetch",fetchMock);
    const { notify }=renderSettings(page);
    const save=screen.getByRole("button",{name:page==="settings-security"?"保存安全策略":"保存通知设置"});
    expect(save).toBeDisabled(); fireEvent.click(save);
    expect(fetchMock).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText(/覆盖率.*100%|预计响应|预览已发送/)).not.toBeInTheDocument();
  });
  it("preserves backend backup and audit permission boundaries", () => {
    renderSettings("settings-backup");
    expect(screen.getByRole("status")).toHaveTextContent("没有 system:backup 权限");
    expect(screen.queryByRole("button",{name:"创建系统备份"})).not.toBeInTheDocument();
  });
  it("never fills settings audit with local example rows", () => {
    const fetchMock=vi.fn(); vi.stubGlobal("fetch",fetchMock);
    renderSettings("settings-audit");
    expect(screen.getByRole("status")).toHaveTextContent("没有 audit:read 权限");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
