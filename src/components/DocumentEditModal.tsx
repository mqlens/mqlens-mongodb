import React, { useEffect, useMemo, useState } from 'react';
import { FileJson } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { shellToEjson } from '../lib/shellDoc';
import { useMonacoTheme } from '../lib/useMonacoTheme';
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

function validateDocument(text: string): string | null {
  if (!text.trim()) return 'Document is empty.';
  let parsed: unknown;
  try {
    parsed = JSON.parse(shellToEjson(text));
  } catch (e: any) {
    return `Invalid document: ${e?.message || 'syntax error'}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'A document must be an object (e.g. { "field": value }).';
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
  const [json, setJson] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const validationError = useMemo(() => validateDocument(json), [json]);
  const theme = useMonacoTheme();
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
              {mode === 'insert' ? 'Insert Document' : 'Edit Document'}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-6 py-4">
          <Label htmlFor="document-json-editor">Document</Label>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
            <Editor
              height="100%"
              defaultLanguage="javascript"
              language="javascript"
              theme={theme}
              value={json}
              onChange={(v) => setJson(v ?? '')}
              wrapperProps={{ 'data-testid': 'document-json-input' }}
              onMount={(_editor, monaco) => {
                monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
                  noSemanticValidation: true,
                  noSyntaxValidation: true,
                  noSuggestionDiagnostics: true,
                });
                monaco.languages.json?.jsonDefaults?.setDiagnosticsOptions({ validate: false });
              }}
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                folding: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                fontSize: 12.5,
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
            Shell types are supported (e.g. {'ObjectId("..."), ISODate("..."), NumberLong("...")'}).
            Editing replaces the entire document.
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
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !!validationError}
            data-testid="document-save-btn"
          >
            {mode === 'insert' ? 'Insert' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DraggableDialogContent>
    </Dialog>
  );
};
