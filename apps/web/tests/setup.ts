import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetCredentialCopyForTest } from "../src/components/credential-copy.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    public observe(): void {}
    public unobserve(): void {}
    public disconnect(): void {}
  };
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = (): void => undefined;
}

if (navigator.clipboard === undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (): Promise<void> => undefined,
      readText: async (): Promise<string> => "",
    },
  });
}

afterEach(() => {
  cleanup();
  resetCredentialCopyForTest();
});
