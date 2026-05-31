import '@testing-library/jest-dom';

// Mock ResizeObserver for jsdom testing environment
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = MockResizeObserver;
