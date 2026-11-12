import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTokensPanel } from "../features/settings/ApiTokensPanel";
import { setCsrfToken } from "../api/client";

const record={id:"11111111-1111-4111-8111-111111111111",name:"CI 只读令牌",permissions:["overview:read"],nodeScope:[],createdAt:"2026-11-12T12:00:00.000Z",expiresAt:null,lastUsedAt:null,revokedAt:null};
const secret="sp_test_server_secret_with_more_than_thirty_two_characters";
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}});
afterEach(()=>{vi.unstubAllGlobals();setCsrfToken("");});
describe("real settings token integration",()=>{
  it("does not request token data without its management permission",()=>{
    const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
    render(<ApiTokensPanel permissions={[]} readOnly={false} notify={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("tokens:manage");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reauthenticates, uses the existing token endpoint, and clears the one-time secret on close",async()=>{
    const user=userEvent.setup(),notify=vi.fn();
    const fetchMock=vi.fn(async(input:string|Request|URL,init?:RequestInit)=>{
      if(String(input)==="/api/auth/reauthenticate")return response({proof:"reauth_proof_with_more_than_thirty_two_characters",expiresAt:"2026-11-12T13:00:00.000Z"});
      if(String(input)==="/api/tokens"&&init?.method==="POST")return response({token:secret,record});
      return response({tokens:[]});
    });
    vi.stubGlobal("fetch",fetchMock);setCsrfToken("csrf_token_with_more_than_thirty_two_characters");
    render(<ApiTokensPanel permissions={["tokens:manage","overview:read"]} readOnly={false} notify={notify} />);
    await screen.findAllByText("当前账号尚无访问令牌");
    await user.click(screen.getByRole("button",{name:"生成令牌"}));
    const confirm=screen.getByRole("alertdialog",{name:"生成访问令牌"});
    expect(within(confirm).getByRole("button",{name:"确认生成"})).toBeDisabled();
    await user.type(within(confirm).getByLabelText("令牌名称"),"CI 只读令牌");
    await user.type(within(confirm).getByLabelText("当前密码"),"current-password");
    await user.click(within(confirm).getByRole("button",{name:"确认生成"}));
    const drawer=await screen.findByRole("dialog",{name:"新访问令牌"});
    expect(within(drawer).getByText(secret)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens",expect.objectContaining({method:"POST",headers:expect.objectContaining({"X-Reauth-Proof":expect.any(String),"X-CSRF-Token":expect.any(String)}),body:JSON.stringify({name:"CI 只读令牌",permissions:["overview:read"],nodeScope:[],expiresAt:null})}));
    await user.click(within(drawer).getByRole("button",{name:"我已保存"}));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(JSON.stringify(window.localStorage)).not.toContain(secret);
  });
  it("requires a new password proof to revoke a server token and reloads its actual revoked state",async()=>{
    const user=userEvent.setup();let revoked=false;
    const fetchMock=vi.fn(async(input:string|Request|URL,init?:RequestInit)=>{
      if(String(input)==="/api/auth/reauthenticate")return response({proof:"reauth_proof_with_more_than_thirty_two_characters",expiresAt:"2026-11-12T13:00:00.000Z"});
      if(init?.method==="DELETE"){revoked=true;return response({message:"Token 已撤销"});}
      return response({tokens:[{...record,revokedAt:revoked?"2026-11-12T12:30:00.000Z":null}]});
    });
    vi.stubGlobal("fetch",fetchMock);
    render(<ApiTokensPanel permissions={["tokens:manage","overview:read"]} readOnly={false} notify={vi.fn()} />);
    const actions=await screen.findAllByRole("button",{name:"撤销令牌 CI 只读令牌"});await user.click(actions[0]);
    const dialog=screen.getByRole("alertdialog",{name:"撤销访问令牌"});
    expect(within(dialog).getByRole("button",{name:"确认撤销"})).toBeDisabled();
    await user.type(within(dialog).getByLabelText("当前密码"),"current-password");
    await user.click(within(dialog).getByRole("button",{name:"确认撤销"}));
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith("/api/tokens/"+record.id,expect.objectContaining({method:"DELETE",headers:expect.objectContaining({"X-Reauth-Proof":expect.any(String)})})));
    expect(await screen.findAllByText("已撤销")).toHaveLength(2);
  });
});
