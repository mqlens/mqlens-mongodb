import React, { useEffect, useMemo, useState } from 'react';
import { X, FileJson } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { shellToEjson } from '../lib/shellDoc';
import { useMonacoTheme } from '../lib/useMonacoTheme';
import { useEscapeClose } from '../lib/useEscapeClose';

// Validate the (shell-syntax) document text: convert to Extended JSON and parse.
// Returns an error message, or null when valid. Shell types (ISODate/ObjectId/…)
// are accepted; genuinely malformed input (stray tokens, bad EJSON) is rejected.
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

  if (!isOpen) return null;

  const handleSave = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    // Convert the shell types (ISODate(...), ObjectId(...), …) to Extended JSON.
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
    // No click-outside close: unsaved document edits are too easy to lose.
    <div className="nested-modal-overlay select-none" data-testid="document-edit-modal">
      <div className="index-modal-container index-modal-container--wide" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 select-none">
          <div className="flex items-center gap-2">
            <FileJson size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-sm font-semibold text-[var(--text-main)]">
              {mode === 'insert' ? 'Insert Document' : 'Edit Document'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer flex items-center justify-center"
            aria-label="Close modal"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="index-modal-label">Document</label>
          <div className="index-modal-editor">
            <Editor
              height={360}
              defaultLanguage="javascript"
              language="javascript"
              theme={theme}
              value={json}
              onChange={(v) => setJson(v ?? '')}
              wrapperProps={{ 'data-testid': 'document-json-input' }}
              onMount={(_editor, monaco) => {
                // The document is shown in mongosh shell syntax (ISODate(...),
                // ObjectId(...)), which is neither valid JSON nor resolvable JS,
                // so silence both validators to avoid spurious red squiggles.
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
                // No autocomplete in the document editor (avoids stray JS/JSON
                // suggestions like `JSON` and the mispositioned widget).
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                wordBasedSuggestions: 'off',
                parameterHints: { enabled: false },
                hover: { enabled: false },
              }}
            />
          </div>
          <span className="index-modal-help-text">
            Shell types are supported (e.g. {'ObjectId("..."), ISODate("..."), NumberLong("...")'}).
            Editing replaces the entire document.
          </span>
        </div>

        {(error || validationError) && (
          <div className="index-modal-error" data-testid="document-edit-error">
            {error || validationError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3 mt-4">
          <button type="button" onClick={onClose} className="index-modal-btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !!validationError}
            className="index-modal-btn-primary"
            data-testid="document-save-btn"
          >
            {mode === 'insert' ? 'Insert' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};
