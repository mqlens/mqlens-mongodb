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
