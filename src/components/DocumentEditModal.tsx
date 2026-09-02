import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileJson } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { shellToEjson } from '../lib/shellDoc';
import { useMonacoTheme, useMonacoFontSize } from '../lib/useMonacoTheme';
import { DOC_LANGUAGE_ID, registerDocLanguage } from '../lib/monacoDocLanguage';
import { attachMonaco } from '../lib/monacoAppTheme';
import { useEscapeClose } from '../lib/useEscapeClose';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

function validateDocument(text: string, t: TFunction): string | null {
  if (!text.trim()) return t('documents:editModal.errors.empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(shellToEjson(text));
  } catch (e: any) {
    return t('documents:editModal.errors.invalid', { message: e?.message || t('documents:editModal.errors.syntaxError') });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return t('documents:editModal.errors.mustBeObject');
  }
  return null;
}

interface DocumentEditModalProps {
  isOpen: boolean;
  mode: 'insert' | 'edit';
  initialJson: string;
  onClose: () => void;
  onSave: (json: string) => void | Promise<void>;
  /** The draft text, when the caller wants to own it.
   *
   *  Held here, an edit dies whenever this dialog unmounts — which is exactly
   *  what happens when the user looks at another tab. Lifting it lets the edit
   *  belong to the tab it was opened from, so switching away and back returns
   *  to the text as it was (#277). Omit both to keep the text locally. */
  json?: string;
  onJsonChange?: (json: string) => void;
  /** A save of the current edit that failed, and whether one is in flight.
   *
   *  Owned by the caller for the same reason the draft is: they belong to the
   *  edit, not to this dialog, and this dialog comes and goes with the active
   *  tab. Held here they were repeatedly shown against the wrong edit or lost
   *  on the way back to the right one — a keyed map fixed the first and still
   *  could not tell "a new edit began" from "the old one is visible again",
   *  because both look alike from in here (#326 review). The caller knows the
   *  difference, so the caller keeps them. */
  error?: string | null;
  saving?: boolean;
  /** The edit is on its way to another window: show it, change nothing.
   *
   *  Between dispatching a move and the reconciliation that takes the tab away,
   *  this window still shows the editor while the backend may already have
   *  handed the tab over. Anything typed here would be mirrored under an id the
   *  destination no longer reconciles, and a save started here would not travel
   *  with it (#326 review). Read-only says so, rather than quietly dropping the
   *  keystrokes. */
  frozen?: boolean;
}

export const DocumentEditModal: React.FC<DocumentEditModalProps> = ({
  isOpen,
  mode,
  initialJson,
  onClose,
  onSave,
  json: controlledJson,
  onJsonChange,
  error = null,
  saving = false,
  frozen = false,
}) => {
  const { t } = useTranslation('documents');
  const [uncontrolledJson, setUncontrolledJson] = useState(initialJson);
  const json = controlledJson ?? uncontrolledJson;
  const setJson = (next: string) => {
    setUncontrolledJson(next);
    onJsonChange?.(next);
  };
  // Derived from the text on screen, so it needs no owner and no lifetime: it
  // is recomputed rather than remembered, and cannot outlive what it describes.
  const validationError = useMemo(() => validateDocument(json, t), [json, t]);
  const theme = useMonacoTheme();
  const monacoRef = useRef<Parameters<
    NonNullable<React.ComponentProps<typeof Editor>['onMount']>
  >[1] | null>(null);

  // Themes are owned by ThemeProvider now, so there is nothing to refresh
  // here. This used to redefine the GLOBAL themes from whatever CSS variables
  // were live, which could overwrite a correct definition another editor had
  // just made — the "can fight" the old comment warned about (#324 review).
  useEffect(() => {
    if (!isOpen) monacoRef.current = null;
  }, [isOpen]);
  const monacoFontSize = useMonacoFontSize(12.5);
  useEscapeClose(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    // Only reset the text we own. A controlled draft is reset by whoever holds
    // it — resetting here would wipe the edit every time the dialog reappeared,
    // which is precisely what returning to a tab does. Nothing else is reset
    // here: this effect cannot tell a new edit from an old one coming back into
    // view, and everything that turns on that distinction now lives with the
    // caller, who can (#326 review).
    if (controlledJson === undefined) setUncontrolledJson(initialJson);
    // `controlledJson` is deliberately not a dependency: this runs when the
    // dialog opens, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialJson]);

  // Save is disabled while `validationError` is set, so reaching here means the
  // text parses. The caller runs the request and reports back through `saving`
  // and `error`.
  const handleSave = () => {
    if (validationError) return;
    onSave(shellToEjson(json));
  };

  return (
    // `modal={false}`: editing a document is exactly when
    // you want to glance at another tab — to compare a field or copy an id —
    // and a modal made that cost you the edit (#277). Without the focus trap
    // and the scrim the rest of the app stays usable while this is open. Radix
    // omits the overlay altogether outside modal mode, so there is no scrim to
    // hide — the dialog simply floats above the app.
    <Dialog modal={false} open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DraggableDialogContent
        defaultWidth={820}
        defaultHeight={560}
        minWidth={520}
        minHeight={360}
        resetKey={isOpen}
        hideClose
        className="flex min-h-0 flex-col gap-0 p-0"
        data-testid="document-edit-modal"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader
          data-dialog-drag-handle
          className="cursor-grab border-b border-border px-6 py-4 active:cursor-grabbing"
        >
          <div className="flex items-center gap-2">
            <FileJson size={16} className="text-primary" />
            <DialogTitle className="text-sm">
              {mode === 'insert' ? t('editModal.title.insert') : t('editModal.title.edit')}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-6 py-4">
          <Label htmlFor="document-json-editor">{t('editModal.labels.document')}</Label>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
            <Editor
              height="100%"
              // Not `javascript`: Monaco's JS tokenizer emits plain `string` for
              // every quoted literal, so a key cannot be coloured differently
              // from a string value and the editor could not match the grid.
              // Nothing else is lost — this editor already disables suggestions
              // and diagnostics, so the language was only ever doing highlighting.
              defaultLanguage={DOC_LANGUAGE_ID}
              language={DOC_LANGUAGE_ID}
              theme={theme}
              value={json}
              onChange={(v) => setJson(v ?? '')}
              wrapperProps={{ 'data-testid': 'document-json-input' }}
              onMount={(_editor, monaco) => {
                monacoRef.current = monaco;
                registerDocLanguage(monaco);
                // The theme's token colours come from the same design tokens the
                // grid uses, so both must be registered before the editor paints.
                // Themes are owned by ThemeProvider; announcing the instance is
                // enough, and it is themed immediately from current state.
                attachMonaco(monaco);
              }}
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                folding: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                fontSize: monacoFontSize,
                tabSize: 2,
                automaticLayout: true,
                overviewRulerLanes: 0,
                renderLineHighlight: 'line',
                padding: { top: 8, bottom: 8 },
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                wordBasedSuggestions: 'off',
                parameterHints: { enabled: false },
                hover: { enabled: false },
                readOnly: frozen,
              }}
            />
          </div>
          <DialogDescription className="text-xs">
            {t('editModal.hints.shellTypes', {
              example: 'ObjectId("..."), ISODate("..."), NumberLong("...")',
            })}
          </DialogDescription>
        </div>

        {(error || validationError) && (
          <div
            className="mx-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="document-edit-error"
          >
            {error || validationError}
          </div>
        )}

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('editModal.actions.cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || frozen || !!validationError}
            data-testid="document-save-btn"
          >
            {mode === 'insert' ? t('editModal.actions.insert') : t('editModal.actions.saveChanges')}
          </Button>
        </DialogFooter>
      </DraggableDialogContent>
    </Dialog>
  );
};
