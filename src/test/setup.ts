import '@testing-library/jest-dom';

// Mock ResizeObserver for jsdom testing environment
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = MockResizeObserver;

// cmdk and Radix scroll areas call scrollIntoView; jsdom does not implement it.
Element.prototype.scrollIntoView = function scrollIntoView() {};

// jsdom does not implement DragEvent (https://github.com/jsdom/jsdom/issues/2913),
// so @testing-library/dom's fireEvent.dragOver/drop/dragStart fall back to the
// base Event constructor and silently drop clientX/clientY/dataTransfer from the
// event init. Polyfill it as a MouseEvent subclass so drag-and-drop tests observe
// real coordinates on the synthetic event.
if (typeof globalThis.DragEvent === 'undefined') {
  class DragEventPolyfill extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, eventInitDict: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
      super(type, eventInitDict);
      this.dataTransfer = eventInitDict.dataTransfer ?? null;
    }
  }
  globalThis.DragEvent = DragEventPolyfill;
}
