import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostMonitoringRecord } from "@stackpilot/contracts";

function capacity(bytes:number) { const units=["B","KiB","MiB","GiB","TiB"];let value=bytes,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return `${value.toFixed(index?1:0)} ${units[index]}`; }
export function SshDiskDetails({disk}:{disk:HostMonitoringRecord["disk"]}) {
  const id=useId(),button=useRef<HTMLButtonElement>(null),opening=useRef<number|null>(null),closing=useRef<number|null>(null);
  const [position,setPosition]=useState<{left:number;top:number;above:boolean;height:number}|null>(null);
  const clearClose=()=>{if(closing.current!==null)window.clearTimeout(closing.current);closing.current=null;};
  const hide=()=>{if(opening.current!==null)window.clearTimeout(opening.current);opening.current=null;clearClose();closing.current=window.setTimeout(()=>setPosition(null),100);};
  const show=()=>{clearClose();if(!disk?.volumes.length||opening.current!==null||position)return;opening.current=window.setTimeout(()=>{opening.current=null;const rect=button.current?.getBoundingClientRect();if(!rect)return;const above=rect.top>window.innerHeight/2;setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-268)),top:above?rect.top-8:rect.bottom+8,above,height:Math.max(80,(above?rect.top:window.innerHeight-rect.bottom)-16)});},400);};
  useEffect(()=>()=>{if(opening.current!==null)window.clearTimeout(opening.current);if(closing.current!==null)window.clearTimeout(closing.current);},[]);
  useEffect(()=>{if(!position)return;const close=(event:Event)=>{if(event.target instanceof Element&&event.target.closest(".ssh-disk-tooltip"))return;setPosition(null);};window.addEventListener("scroll",close,true);window.addEventListener("resize",close);return()=>{window.removeEventListener("scroll",close,true);window.removeEventListener("resize",close);};},[position]);
  if(!disk)return <>等待采集</>;
  const total=disk.volumes.length?disk.volumes.reduce((sum,v)=>sum+v.totalBytes,0):disk.totalBytes,used=disk.volumes.length?disk.volumes.reduce((sum,v)=>sum+v.usedBytes,0):disk.usedBytes;
  const percent=total>0?`${(used/total*100).toFixed(1)}%`:"容量不可用";
  return <><button ref={button} type="button" className="ssh-disk-trigger" aria-label={`全部磁盘使用率 ${percent}`} aria-describedby={position?id:undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={event=>{if(!position)return;if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();document.getElementById(id)?.scrollBy({top:event.key==="ArrowDown"?80:-80});}if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setPosition(null);}}}>{percent}</button>{position&&createPortal(<div className={`ssh-disk-tooltip-position ${position.above?"above":"below"}`} style={{left:position.left,top:position.top}} onMouseEnter={clearClose} onMouseLeave={hide}><div role="tooltip" id={id} className="ssh-disk-tooltip" style={{maxHeight:position.height}}><strong>全部磁盘卷</strong>{disk.volumes.map(v=><span key={`${v.label}:${v.mountPath}`}><b>{v.label} ({v.mountPath})</b><span>{v.percent.toFixed(1)}% · {capacity(v.usedBytes)} / {capacity(v.totalBytes)}</span></span>)}<span>合计 {capacity(used)} / {capacity(total)}</span></div></div>,document.body)}</>;
}
