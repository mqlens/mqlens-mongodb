import type { TFunction } from 'i18next';
import type { DialogApi } from '@/components/dialogs/DialogProvider';

/**
 * Typed-name confirmation for a destructive operation on a `confirm_destructive`
 * (production-safeguard) connection (#188 Task 3). The user must type the
 * exact collection/database name before the caller may pass `confirmed: true`
 * to the backend command — the backend's `guard_writable` is the real gate
 * (it never trusts the UI), this dialog just keeps an accidental click from
 * ever reaching it with `confirmed: true`.
 *
 * Shared between App.tsx (delete_many/update_many) and Sidebar.tsx
 * (drop_collection/rename_collection/drop_database/rename_database) so the
 * wording and matching rule (trimmed exact match) stay identical everywhere.
 *
 * Resolves `true` iff the user typed an exact match; `false` if they
 * cancelled the dialog.
 *
 * `t` is injected rather than read from a hook — this is a plain module
 * function, not a component, so it cannot call `useTranslation` (same
 * pattern as `tabLabelFor` in App.tsx). Only the default message and the
 * validation error text are translated; `expectedName` and the comparison
 * against the user's typed input stay the raw collection/database name,
 * never a translated string (a German catalog value must never reach
 * `invoke('create_collection')`/`drop_collection`/etc.).
 */
export async function confirmByTypedName(
  prompt: DialogApi['prompt'],
  opts: {
    title: string;
    /** What's being typed — used in the default message ("Type the {kind} name to confirm."). */
    kind: 'collection' | 'database';
    /** The exact string the user must type (trimmed) to proceed. */
    expectedName: string;
    /** Overrides the default message; still validated against `expectedName`. */
    message?: string;
  },
  t: TFunction
): Promise<boolean> {
  const defaultMessageKey =
    opts.kind === 'collection'
      ? 'common:typedNameConfirm.messageCollection'
      : 'common:typedNameConfirm.messageDatabase';
  const typed = await prompt({
    title: opts.title,
    message: opts.message ?? t(defaultMessageKey),
    placeholder: opts.expectedName,
    validate: (v) => (v.trim() === opts.expectedName ? null : t('common:typedNameConfirm.validationError')),
  });
  return typed !== null;
}
