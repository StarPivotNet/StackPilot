import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitPageUpdate } from "../app/pageTransition";
import { PageTransition } from "../components/layout/PageTransition";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "startViewTransition");
  document.documentElement.classList.remove("supports-view-transitions");
});

describe("PageTransition", () => {
  it("animates only after the active page changes and can restart", () => {
    const view = render(<PageTransition page="overview">总览</PageTransition>);
    const surface = view.container.querySelector(".desktop-page-transition");

    expect(surface).not.toHaveClass("is-page-entering");

    view.rerender(<PageTransition page="overview">更新后的总览</PageTransition>);
    expect(surface).not.toHaveClass("is-page-entering");

    view.rerender(<PageTransition page="hosts">主机</PageTransition>);
    expect(surface).toHaveClass("is-page-entering");

    view.rerender(<PageTransition page="sites">站点</PageTransition>);
    expect(surface).toHaveClass("is-page-entering");
  });
});

describe("commitPageUpdate", () => {
  it("uses a native view transition when the browser supports it", () => {
    const update = vi.fn();
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: Promise.resolve() } as ViewTransition;
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });

    commitPageUpdate(update);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("supports-view-transitions");
  });

  it("updates directly when native view transitions are unavailable", () => {
    const update = vi.fn();

    commitPageUpdate(update);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("observes a skipped animation without replaying updates or losing the latest route", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    let current = "overview";
    const updates = [vi.fn(() => { current = "hosts"; }), vi.fn(() => { current = "sites"; })];
    const transitions: ViewTransition[] = [];
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (callback: () => void) => {
      const done = Promise.resolve().then(callback);
      const transition = {
        ready: transitions.length ? done : Promise.reject(new DOMException("Transition was skipped. New ViewTransition started", "AbortError")),
        updateCallbackDone: done,
        finished: done,
      } as ViewTransition;
      transitions.push(transition);
      return transition;
    } });

    commitPageUpdate(updates[0]);
    commitPageUpdate(updates[1]);
    await Promise.allSettled(transitions.flatMap((transition) => [transition.ready, transition.updateCallbackDone, transition.finished]));

    expect(updates[0]).toHaveBeenCalledTimes(1);
    expect(updates[1]).toHaveBeenCalledTimes(1);
    expect(current).toBe("sites");
    expect(report).not.toHaveBeenCalled();
  });

  it.each([new Error("update failed"), new DOMException("update aborted", "AbortError")])("reports a real update failure once, including an update AbortError", async (reason) => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const update = vi.fn(() => { throw reason; });
    let transition!: ViewTransition;
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (callback: () => void) => {
      const done = Promise.resolve().then(callback);
      transition = { ready: done.then(() => undefined), updateCallbackDone: done, finished: done } as ViewTransition;
      return transition;
    } });

    commitPageUpdate(update);
    await Promise.allSettled([transition.ready, transition.updateCallbackDone, transition.finished]);

    expect(update).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("keeps an unexpected animation setup failure visible", async () => {
    const report = vi.fn(), reason = new DOMException("Duplicate transition names", "InvalidStateError");
    vi.stubGlobal("reportError", report);
    const ready: Promise<void> = Promise.reject(reason);
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: (callback: () => void) => {
      callback();
      return { ready, updateCallbackDone: Promise.resolve(), finished: Promise.resolve() } as ViewTransition;
    } });

    commitPageUpdate(vi.fn());
    await Promise.allSettled([ready]);

    expect(report).toHaveBeenCalledExactlyOnceWith(reason);
  });
});
