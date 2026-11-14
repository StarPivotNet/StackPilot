import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../components/ui/DataTable";

type Row = { name: string; revision: string };

const node = { key: "node", label: "节点", render: (row: Row) => row.name };
const revision = { key: "revision", label: "配置版本", render: (row: Row) => row.revision };
const action = { key: "ops", label: "操作", control: true, width: "96px", render: () => <button type="button">详情</button> };

describe("DataTable tail-column declaration", () => {
  it("marks a control tail and hands its declared width to the stylesheet", () => {
    render(<DataTable columns={[node, action]} rows={[{ name: "edge-a", revision: "r7" }]} emptyText="空" getRowKey={(row) => row.name} />);
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("data-tail", "control");
    expect(table.style.getPropertyValue("--tail-column-width")).toBe("96px");
  });

  it("leaves a data tail unmarked so it keeps an even share", () => {
    render(<DataTable columns={[node, revision]} rows={[{ name: "edge-a", revision: "r7" }]} emptyText="空" getRowKey={(row) => row.name} />);
    expect(screen.getByRole("table")).not.toHaveAttribute("data-tail");
  });

  it("does not pin a control column that is not last", () => {
    render(<DataTable columns={[node, action, revision]} rows={[{ name: "edge-a", revision: "r7" }]} emptyText="空" getRowKey={(row) => row.name} />);
    expect(screen.getByRole("table")).not.toHaveAttribute("data-tail");
  });

  it("renders no marker for a table without columns", () => {
    render(<DataTable columns={[]} rows={[]} emptyText="空" getRowKey={() => "row"} />);
    expect(screen.getByRole("table")).not.toHaveAttribute("data-tail");
  });
});
