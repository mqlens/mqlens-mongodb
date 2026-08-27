import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileJson } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { shellToEjson } from '../lib/shellDoc';
import { useMonacoTheme, useMonacoFontSize } from '../lib/useMonacoTheme';
import { DOC_LANGUAGE_ID, registerDocLanguage } from '../lib/monacoDocLanguage';
import { registerMqlensMonacoThemes, refreshMqlensMonacoTheme } from '../lib/monacoAppTheme';
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
}

export const DocumentEditModal: React.FC<DocumentEditModalProps> = ({
  isOpen,
  mode,
  initialJson,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation('documents');
  const [json, setJson] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const validationError = useMemo(() => validateDocument(json, t), [json, t]);
  const theme = useMonacoTheme();
  const monacoRef = useRef<Parameters<
    NonNullable<React.ComponentProps<typeof Editor>['onMount']>
  >[1] | null>(null);

  // `refreshMqlensMonacoTheme` builds *both* theme ids from whatever CSS
  // variables are live at the time, so they are only correct immediately after a
  // refresh. QueryEditor re-runs it on every theme change; without the same here
  // the dialog kept the previous mode's colours — a dark editor in light mode —
  // whenever the mode changed with no query editor mounted to refresh them.
  //
  // Gated on `isOpen`, and the handle is dropped on close: this component stays
  // mounted while the dialog is shut, so an ungated effect redefined the global
  // Monaco themes on every App render. That is wasted work, it can fight
  // QueryEditor's own refresh, and it measurably destabilised unrelated tests.
  useEffect(() => {
    if (!isOpen) {
      monacoRef.current = null;
      return;
    }
    const monaco = monacoRef.current;
    if (!monaco) return;
    refreshMqlensMonacoTheme(monaco);
    monaco.editor.setTheme(theme);
  }, [isOpen, theme]);
  const monacoFontSize = useMonacoFontSize(12.5);
  useEscapeClose(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      setJson(initialJson);
      setError(null);
      setSaving(false);
    }
  }, [isOpen, initialJson]);

  const handleSave = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    const ejson = shellToEjson(json);
    setError(null);
    setSaving(true);
    try {
      await onSave(ejson);
    } catch (err: any) {
      setError(String(err?.message || err));
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
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
                registerMqlensMonacoThemes(monaco);
                refreshMqlensMonacoTheme(monaco);
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
            disabled={saving || !!validationError}
            data-testid="document-save-btn"
          >
            {mode === 'insert' ? t('editModal.actions.insert') : t('editModal.actions.saveChanges')}
          </Button>
        </DialogFooter>
      </DraggableDialogContent>
    </Dialog>
  );
};
