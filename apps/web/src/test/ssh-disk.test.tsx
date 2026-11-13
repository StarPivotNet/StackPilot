import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SshDiskDetails } from "../features/ssh/SshDiskDetails";
afterEach(()=>vi.useRealTimers());
it("weights every volume and reveals all capacities after the keyboard tooltip delay",async()=>{
  vi.useFakeTimers();render(<SshDiskDetails disk={{totalBytes:400,usedBytes:100,percent:50,volumes:[{label:"root",mountPath:"/",totalBytes:100,usedBytes:100,percent:100},{label:"data",mountPath:"/data",totalBytes:300,usedBytes:0,percent:0}]}}/>);
  const button=screen.getByRole("button",{name:"全部磁盘使用率 25.0%"});fireEvent.focus(button);await act(()=>vi.advanceTimersByTimeAsync(399));expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();await act(()=>vi.advanceTimersByTimeAsync(1));expect(screen.getByRole("tooltip")).toHaveTextContent("root (/)");expect(screen.getByRole("tooltip")).toHaveTextContent("data (/data)");expect(screen.getByRole("tooltip")).toHaveTextContent("100 B / 100 B");expect(screen.getByRole("tooltip")).toHaveTextContent("0 B / 300 B");fireEvent.keyDown(button,{key:"Escape"});expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
