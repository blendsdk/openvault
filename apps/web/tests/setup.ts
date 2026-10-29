import "@testing-library/jest-dom/vitest";

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
