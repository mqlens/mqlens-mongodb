import { describe, it, expect, vi } from 'vitest';
import { confirmByTypedName } from '../typedNameConfirm';
import type { DialogApi } from '@/components/dialogs/DialogProvider';

describe('confirmByTypedName', () => {
  // Regression test for Critical 4 (final review, task-6-report.md): the
  // default message ("Type the {kind} name to confirm.") and, unconditionally,
  // the validation error ("Name does not match") were hardcoded English.
  // Callers can override `message` but never the validation string — so a
  // German user mistyping the name inside this exact production-safeguard
  // dialog got an English error. Asserts both are German under the `de`
  // locale, using the real i18next instance (not a `t` stub), and that the
  // comparison itself still targets the raw, untranslated `expectedName`.
  it('uses German default message and validation error under the de locale, while still comparing the raw name', async () => {
    const { i18next } = await import('@/lib/i18n');
    await i18next.changeLanguage('de');
    try {
      let capturedOpts: Parameters<DialogApi['prompt']>[0] | undefined;
      const prompt = vi.fn(async (opts: Parameters<DialogApi['prompt']>[0]) => {
        capturedOpts = opts;
        // Simulate a mistyped name to exercise the validate() error path.
        return opts.validate?.('wrong-name') ? null : 'orders';
      }) as unknown as DialogApi['prompt'];

      const t = i18next.getFixedT('de');
      await confirmByTypedName(
        prompt,
        { title: 'Collection löschen', kind: 'collection', expectedName: 'orders' },
        t,
      );

      // "Collection", not "Sammlung": MongoDB's object names stay as MongoDB
      // spells them, in German too.
      expect(capturedOpts?.message).toBe(
        'Gib den Namen der Collection ein, um zu bestätigen.'
      );
      expect(capturedOpts?.validate?.('wrong-name')).toBe('Name stimmt nicht überein');
      // The comparison itself must stay against the raw name, never a
      // translated value — a mistyped guess must fail, and the exact name
      // (regardless of locale) must still pass.
      expect(capturedOpts?.validate?.('orders')).toBeNull();
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('lets an explicit message override the default, but never the validation error', async () => {
    const { i18next } = await import('@/lib/i18n');
    await i18next.changeLanguage('de');
    try {
      let capturedOpts: Parameters<DialogApi['prompt']>[0] | undefined;
      const prompt = vi.fn(async (opts: Parameters<DialogApi['prompt']>[0]) => {
        capturedOpts = opts;
        return null;
      }) as unknown as DialogApi['prompt'];

      const t = i18next.getFixedT('de');
      await confirmByTypedName(
        prompt,
        { title: 'x', kind: 'database', expectedName: 'prod', message: 'Custom message' },
        t,
      );

      expect(capturedOpts?.message).toBe('Custom message');
      expect(capturedOpts?.validate?.('nope')).toBe('Name stimmt nicht überein');
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});
