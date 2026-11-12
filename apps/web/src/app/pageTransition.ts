import { flushSync } from "react-dom";

function commitPageUpdate(update: () => void) {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }

  document.documentElement.classList.add("supports-view-transitions");
  const transition = document.startViewTransition(() => flushSync(update));
  const reported = new Set<unknown>();
  const reportFailure = (reason: unknown) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    reportError(reason);
  };
  void transition.ready.catch((reason: unknown) => {
    // A newer navigation may skip the animation without skipping its DOM update.
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    reportFailure(reason);
  });
  // An update callback can itself throw AbortError: that is a real failure.
  void transition.updateCallbackDone.catch(reportFailure);
  void transition.finished.catch(reportFailure);
}

export { commitPageUpdate };
