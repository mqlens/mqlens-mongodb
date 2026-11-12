import type { TFunction } from 'i18next';
import type { DialogApi } from '@/components/dialogs/DialogProvider';

/**
 * Typed-name confirmation for destructive operations. The final action stays
 * disabled until the raw input exactly matches the target name.
 *
 * Shared between App.tsx (delete_many/update_many) and Sidebar.tsx
 * (drop_collection/rename_collection/drop_database/rename_database) so the
 * wording and matching rule stay identical everywhere.
 *
 * Resolves `true` iff the user typed an exact match; `false` if they
 * cancelled the dialog.
 *
 * `t` is injected rather than read from a hook — this is a plain module
 * function, not a component, so it cannot call `useTranslation` (same
 * pattern as `tabLabelFor` in App.tsx). Only the default message and the
 * validation error text are translated; `expectedName` and the comparison
 * against the user's typed input stay the raw target name,
 * never a translated string (a German catalog value must never reach
 * `invoke('create_collection')`/`drop_collection`/etc.).
 */
export async function confirmByTypedName(
  prompt: DialogApi['prompt'],
  opts: {
    title: string;
    /** What's being typed — used in the default message ("Type the {kind} name to confirm."). */
    kind: 'collection' | 'database' | 'index';
    /** The exact string the user must type to proceed. */
    expectedName: string;
    /** Overrides the default message; still validated against `expectedName`. */
    message?: string;
    destructive?: boolean;
  },
  t: TFunction
): Promise<boolean> {
  const defaultMessageKey = opts.kind === 'collection'
    ? 'common:typedNameConfirm.messageCollection'
    : opts.kind === 'database'
      ? 'common:typedNameConfirm.messageDatabase'
      : 'common:typedNameConfirm.messageIndex';
  const typed = await prompt({
    title: opts.title,
    message: opts.message ?? t(defaultMessageKey),
    placeholder: opts.expectedName,
    confirmLabel: opts.destructive ? t('common:typedNameConfirm.confirmLabel') : undefined,
    confirmEnabled: (v) => v === opts.expectedName,
    destructive: opts.destructive,
    validate: (v) => (v === opts.expectedName ? null : t('common:typedNameConfirm.validationError')),
  });
  return typed !== null;
}
