import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factory can reference it (vi.mock is lifted above imports).
const { installMock } = vi.hoisted(() => ({ installMock: vi.fn() }));
vi.mock('../crashLog', () => ({ installCrashHandlers: installMock }));

describe('bootstrapCrashHandlers (#381 review)', () => {
  beforeEach(() => {
    installMock.mockClear();
    vi.resetModules();
  });

  it('installs the crash handlers as a side effect of being imported', async () => {
    // main.tsx imports this module before ./App precisely so the handlers are
    // up before the app graph evaluates — the value here is that merely
    // importing it (not calling anything) installs them.
    await import('../bootstrapCrashHandlers');
    expect(installMock).toHaveBeenCalledTimes(1);
  });
});
