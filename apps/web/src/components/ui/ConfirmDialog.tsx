import { AlertTriangle, Info, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { drawerFocusableElements, drawerRestoreFallback, restoreFocusAfterUnmount } from "../../utils/focus";
import { useExitMotion } from "./useExitMotion";

function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel,
  onConfirm,
  onClose,
  tone = "danger",
  className,
  busy = false,
  confirmDisabled = false,
  restoreFocusTarget,
  children,
}: {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  tone?: "danger" | "warning" | "info";
  className?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  restoreFocusTarget?: HTMLElement | null;
  children?: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { closing, requestClose } = useExitMotion(onClose);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = restoreFocusTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) {
        dialog.querySelector<HTMLElement>("[data-confirm-initial], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [data-confirm-cancel]")
          ?.focus({ preventScroll: true });
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !document.contains(dialog)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (busy) return;
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = drawerFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      const restoreTarget = previousFocus && document.contains(previousFocus) && !previousFocus.hasAttribute("disabled")
        ? previousFocus
        : drawerRestoreFallback(dialog);
      restoreFocusAfterUnmount(dialog, restoreTarget);
    };
  }, [requestClose, restoreFocusTarget, busy]);

  return createPortal(
    <>
      <button className={["confirm-dialog-scrim", className ? `${className}-scrim` : ""].filter(Boolean).join(" ")} data-closing={closing || undefined} type="button" aria-label="关闭确认弹窗" onClick={requestClose} tabIndex={-1} disabled={busy || closing} />
      <div
        ref={dialogRef}
        className={["confirm-dialog", className].filter(Boolean).join(" ")}
        data-closing={closing || undefined}
        role={tone === "info" ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        inert={closing || undefined}
        tabIndex={-1}
      >
        <header>
          <span className={`confirm-dialog-icon ${tone}`}>{tone === "info" ? <Info size={20} /> : <AlertTriangle size={20} />}</span>
          <strong id={titleId}>{title}</strong>
          <button className="icon-action" type="button" aria-label="关闭确认弹窗" disabled={busy || closing} onClick={requestClose}><X size={16} /></button>
        </header>
        <div className="confirm-dialog-body">
          <p id={descriptionId}>{message}</p>
          {detail && <code>{detail}</code>}
          {children}
        </div>
        <footer>
          <button className="ghost" type="button" data-confirm-cancel disabled={busy || closing} onClick={requestClose}>取消</button>
          <button className={tone === "danger" ? "trash-destructive" : "primary"} type="button" disabled={busy || closing || confirmDisabled} onClick={onConfirm}>{busy ? "处理中" : confirmLabel}</button>
        </footer>
      </div>
    </>,
    document.body,
  );
}

export { ConfirmDialog };
