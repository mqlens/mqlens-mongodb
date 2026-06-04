import React, { useEffect, useState } from 'react';
import { X, FileJson } from 'lucide-react';
import Editor from '@monaco-editor/react';

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
  const theme =
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
      ? 'light'
      : 'vs-dark';

  useEffect(() => {
    if (isOpen) {
      setJson(initialJson);
      setError(null);
      setSaving(false);
    }
  }, [isOpen, initialJson]);

  if (!isOpen) return null;

  const handleSave = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err: any) {
      setError(`Invalid JSON: ${err.message || 'syntax error'}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('A document must be a JSON object (e.g. { "field": value }).');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(json);
    } catch (err: any) {
      setError(String(err?.message || err));
      setSaving(false);
    }
  };

  return (
    <div className="nested-modal-overlay select-none" data-testid="document-edit-modal" onClick={onClose}>
      <div className="index-modal-container" onClick={(e) => e.stopPropagation()}>
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
          <label className="index-modal-label">Document (JSON)</label>
          <div className="index-modal-editor">
            <Editor
              height={360}
              defaultLanguage="json"
              theme={theme}
              value={json}
              onChange={(v) => setJson(v ?? '')}
              wrapperProps={{ 'data-testid': 'document-json-input' }}
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                folding: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                fontSize: 12.5,
                tabSize: 2,
                automaticLayout: true,
                fixedOverflowWidgets: true,
                overviewRulerLanes: 0,
                renderLineHighlight: 'line',
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
          <span className="index-modal-help-text">
            MongoDB Extended JSON is supported (e.g. {'{ "_id": { "$oid": "..." } }'}). Editing
            replaces the entire document.
          </span>
        </div>

        {error && (
          <div className="index-modal-error" data-testid="document-edit-error">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3 mt-4">
          <button type="button" onClick={onClose} className="index-modal-btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
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
