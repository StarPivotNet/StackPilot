import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsProxyPage } from "../features/settings/SettingsProxyPage";
afterEach(()=>vi.unstubAllGlobals());
describe("proxy capability boundary",()=>{
  it("shows honest capability states without probing or inventing nodes",()=>{
    const fetchMock=vi.fn(),notify=vi.fn(); vi.stubGlobal("fetch",fetchMock);
    render(<SettingsProxyPage page="settings-proxy" setPage={vi.fn()} notify={notify} readOnlyState={{readOnly:false,setReadOnly:vi.fn()}} />);
    expect(screen.getByRole("heading",{name:"代理设置"})).not.toHaveClass("sr-only");
    expect(screen.getByRole("status")).toHaveTextContent("代理管理接口尚未开放");
    expect(screen.getByText("暂无可读取的代理节点")).toBeInTheDocument();
    const save=screen.getByRole("button",{name:"保存策略"});
    expect(save).toBeDisabled(); fireEvent.click(save);
    expect(fetchMock).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText("http://proxy.local:7890")).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"批量检查"})).not.toBeInTheDocument();
  });
});
