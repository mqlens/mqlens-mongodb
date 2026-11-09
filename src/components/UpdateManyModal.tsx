import React, { useMemo, useRef, useState } from 'react';
import { PencilLine } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { parseShellJson } from '../lib/shellDoc';
import { useMonacoTheme, useMonacoFontSize } from '../lib/useMonacoTheme';
import { useMonacoValue } from '../lib/useMonacoValue';
import { DOC_LANGUAGE_ID, registerDocLanguage } from '../lib/monacoDocLanguage';
import { attachMonaco } from '../lib/monacoAppTheme';
import { useEscapeClose } from '../lib/useEscapeClose';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const DEFAULT_UPDATE = '{\n  $set: {\n    \n  }\n}';

// Parsed like the query bar, so ISODate(), ObjectId() and unquoted keys work.
function parseUpdate(text: string, t: TFunction): { update: string } | { error: string } {
  let parsed: any;
  try {
    parsed = parseShellJson(text);
  } catch {
    return { error: t('documents:dataGrid.dialogs.updateMany.validation.invalidJson') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: t('documents:dataGrid.dialogs.updateMany.validation.mustBeObject') };
  }
  if (Object.keys(parsed).length === 0 || !Object.keys(parsed).every((k) => k.startsWith('$'))) {
    return { error: t('documents:dataGrid.dialogs.updateMany.validation.mustUseOperators') };
  }
  return { update: JSON.stringify(parsed) };
}

const isEmptyFilter = (filter: string) => {
  try { return Object.keys(JSON.parse(filter)).length === 0; } catch { return false; }
};

interface UpdateManyModalProps {
  isOpen: boolean;
  /** The Extended JSON filter the update applies to. */
  filter: string;
  /** How many documents that filter matches right now. */
  count: number;
  onClose: () => void;
  /** Called with the update as Extended JSON. */
  onSubmit: (update: string) => void;
}

/**
 * Update Many as a code editor rather than a one-line prompt. Non-modal, like
 * the document editor (#277): no scrim, so the results it is about to change
 * stay readable behind it. It names the filter and the count itself, so it is
 * also the confirmation; a protected connection still asks for the typed name.
 */
export const UpdateManyModal: React.FC<UpdateManyModalProps> = ({ isOpen, filter, count, onClose, onSubmit }) => {
  const { t } = useTranslation('documents');
  // Kept while hidden (another tab is showing); the caller remounts this per update.
  const [text, setText] = useState(DEFAULT_UPDATE);

  const result = useMemo(() => parseUpdate(text, t), [text, t]);
  const submit = () => {
    if ('update' in result) onSubmit(result.update);
  };
  // Monaco's keybinding outlives renders; read the latest submit through a ref.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const editorValue = useMonacoValue(text, setText);
  const theme = useMonacoTheme();
  const monacoFontSize = useMonacoFontSize(12.5);
  useEscapeClose(isOpen, onClose);

  const target = t('dataGrid.dialogs.updateMany.body', { count, filter })
    + (isEmptyFilter(filter) ? t('dataGrid.dialogs.bulkAllWarning', { count }) : '');

  return (
    <Dialog modal={false} open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DraggableDialogContent
        defaultWidth={640}
        defaultHeight={440}
        minWidth={480}
        minHeight={320}
        resetKey={isOpen}
        hideClose
        className="flex min-h-0 flex-col gap-0 p-0"
        data-testid="update-many-modal"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader data-dialog-drag-handle className="cursor-grab border-b border-border px-6 py-4 active:cursor-grabbing">
          <div className="flex items-center gap-2">
            <PencilLine size={16} className="text-primary" />
            <DialogTitle className="text-sm">{t('dataGrid.dialogs.updateMany.title')}</DialogTitle>
          </div>
          {/* Bounded, so a long filter (a big $in list) scrolls instead of crowding out the editor. */}
          <DialogDescription className="max-h-24 overflow-y-auto whitespace-pre-line break-all pt-1 text-xs" data-testid="update-many-target">
            {target}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-6 py-4">
          <Label htmlFor="update-many-editor">{t('dataGrid.dialogs.updateMany.promptMessage')}</Label>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
            <Editor
              height="100%"
              defaultLanguage={DOC_LANGUAGE_ID}
              language={DOC_LANGUAGE_ID}
              theme={theme}
              defaultValue={editorValue.defaultValue}
              onChange={editorValue.onChange}
              wrapperProps={{ 'data-testid': 'update-many-editor' }}
              onMount={(editor, monaco) => {
                editorValue.onMount(editor, monaco);
                registerDocLanguage(monaco);
                attachMonaco(monaco);
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submitRef.current());
                editor.focus();
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
                padding: { top: 8, bottom: 8 },
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                wordBasedSuggestions: 'off',
                parameterHints: { enabled: false },
                hover: { enabled: 'off' },
              }}
            />
          </div>
          <DialogDescription className="text-xs">{t('dataGrid.dialogs.updateMany.hint')}</DialogDescription>
        </div>

        {'error' in result && (
          <div
            className="mx-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="update-many-error"
          >
            {result.error}
          </div>
        )}

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} data-testid="update-many-cancel">
            {t('editModal.actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={'error' in result}
            data-testid="update-many-submit"
          >
            {t('dataGrid.dialogs.updateMany.confirmLabel')}
          </Button>
        </DialogFooter>
      </DraggableDialogContent>
    </Dialog>
  );
};
