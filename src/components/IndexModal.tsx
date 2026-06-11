import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Code, Layers } from 'lucide-react';
import { useEscapeClose } from '../lib/useEscapeClose';

interface IndexKeyRule {
  field: string;
  direction: 1 | -1;
}

interface IndexModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (indexName: string, keys: string, unique: boolean, sparse: boolean) => void;
  availableFields: string[];
  initialData?: {
    name: string;
    keys: Record<string, number>;
    unique: boolean;
    sparse: boolean;
  } | null;
}

export const IndexModal: React.FC<IndexModalProps> = ({
  isOpen,
  onClose,
  onSave,
  availableFields,
  initialData,
}) => {
  const [indexName, setIndexName] = useState('');
  const [isRawMode, setIsRawMode] = useState(false);
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  
  // Structured Key Builder State
  const [keysList, setKeysList] = useState<IndexKeyRule[]>([{ field: '_id', direction: 1 }]);
  
  // Raw JSON Mode State
  const [rawKeysJson, setRawKeysJson] = useState('{\n  "_id": 1\n}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEscapeClose(isOpen, onClose);

  // Sync state with initial data (when editing) or reset (when creating)
  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setIndexName(initialData.name);
        setUnique(initialData.unique);
        setSparse(initialData.sparse);
        
        // Populate keys list
        const list: IndexKeyRule[] = Object.entries(initialData.keys).map(([field, dir]) => ({
          field,
          direction: dir === -1 ? -1 : 1,
        }));
        setKeysList(list.length > 0 ? list : [{ field: '_id', direction: 1 }]);
        setRawKeysJson(JSON.stringify(initialData.keys, null, 2));
      } else {
        setIndexName('');
        setUnique(false);
        setSparse(false);
        setKeysList([{ field: '_id', direction: 1 }]);
        setRawKeysJson('{\n  "_id": 1\n}');
      }
      setJsonError(null);
      setIsRawMode(false);
    }
  }, [isOpen, initialData]);

  // Synchronize keysList to raw JSON whenever it changes
  useEffect(() => {
    if (!isRawMode) {
      const keysObj: Record<string, number> = {};
      keysList.forEach(k => {
        if (k.field.trim()) {
          keysObj[k.field.trim()] = k.direction;
        }
      });
      setRawKeysJson(JSON.stringify(keysObj, null, 2));
    }
  }, [keysList, isRawMode]);

  if (!isOpen) return null;

  const handleAddKeyRow = () => {
    // Pick first available field that isn't already added, or default to empty
    const addedFields = new Set(keysList.map(k => k.field));
    const nextField = availableFields.find(f => !addedFields.has(f)) || '';
    setKeysList(prev => [...prev, { field: nextField, direction: 1 }]);
  };

  const handleRemoveKeyRow = (index: number) => {
    if (keysList.length <= 1) return;
    setKeysList(prev => prev.filter((_, i) => i !== index));
  };

  const handleKeyRowChange = (index: number, updates: Partial<IndexKeyRule>) => {
    setKeysList(prev => prev.map((k, i) => i === index ? { ...k, ...updates } : k));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setJsonError(null);

    let keysJsonStr = '';

    if (isRawMode) {
      try {
        const parsed = JSON.parse(rawKeysJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Index keys must be a JSON object (e.g. { "field": 1 })');
        }
        // Verify values are either 1 or -1
        Object.entries(parsed).forEach(([key, val]) => {
          if (val !== 1 && val !== -1) {
            throw new Error(`Index direction for "${key}" must be 1 (Ascending) or -1 (Descending)`);
          }
        });
        keysJsonStr = JSON.stringify(parsed);
      } catch (err: any) {
        setJsonError(err.message || 'Invalid JSON syntax');
        return;
      }
    } else {
      const keysObj: Record<string, number> = {};
      let hasEmptyField = false;

      keysList.forEach(k => {
        const fieldName = k.field.trim();
        if (!fieldName) {
          hasEmptyField = true;
        } else {
          keysObj[fieldName] = k.direction;
        }
      });

      if (hasEmptyField) {
        setJsonError('All index key fields must have a name');
        return;
      }

      if (Object.keys(keysObj).length === 0) {
        setJsonError('Please specify at least one index key');
        return;
      }

      keysJsonStr = JSON.stringify(keysObj);
    }

    const trimmedName = indexName.trim();
    if (!trimmedName) {
      setJsonError('Index name is required');
      return;
    }

    onSave(trimmedName, keysJsonStr, unique, sparse);
  };

  return (
    <div className="nested-modal-overlay select-none" data-testid="index-modal" onClick={onClose}>
      <div className="index-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 select-none">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-sm font-semibold text-[var(--text-main)]">
              {initialData ? 'Edit Index definition' : 'Create New Index'}
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

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="index-modal-form">
          
          {/* Index Name Input */}
          <div className="flex flex-col gap-1">
            <label className="index-modal-label">Index Name</label>
            <input
              type="text"
              value={indexName}
              onChange={(e) => setIndexName(e.target.value)}
              placeholder="e.g. email_1_status_-1"
              required
              className="index-modal-input"
              data-testid="index-name-input"
            />
            <span className="index-modal-help-text">A unique identifier to locate and optimize query plans.</span>
          </div>

          {/* Keys Specification */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center mb-1">
              <label className="index-modal-label">Index Key Definition</label>
            </div>

            {/* Premium Segmented Control */}
            <div className="index-modal-segmented-control">
              <button
                type="button"
                className={`segmented-tab ${!isRawMode ? 'active' : ''}`}
                onClick={() => {
                  if (isRawMode) {
                    try {
                      const parsed = JSON.parse(rawKeysJson);
                      const list: IndexKeyRule[] = Object.entries(parsed).map(([field, dir]) => ({
                        field,
                        direction: dir === -1 ? -1 : 1,
                      }));
                      if (list.length > 0) setKeysList(list);
                    } catch (e) {}
                    setIsRawMode(false);
                  }
                }}
              >
                <Layers size={12} />
                <span>Key Builder</span>
              </button>
              <button
                type="button"
                className={`segmented-tab ${isRawMode ? 'active' : ''}`}
                onClick={() => {
                  if (!isRawMode) {
                    const keysObj: Record<string, number> = {};
                    keysList.forEach(k => {
                      if (k.field.trim()) {
                        keysObj[k.field.trim()] = k.direction;
                      }
                    });
                    setRawKeysJson(JSON.stringify(keysObj, null, 2));
                    setIsRawMode(true);
                  }
                }}
              >
                <Code size={12} />
                <span>Raw JSON</span>
              </button>
            </div>

            {/* Builder Mode */}
            {!isRawMode ? (
              <div className="index-modal-keys-list">
                {keysList.map((rule, idx) => (
                  <div key={idx} className="index-modal-key-row">
                    {/* Unified row input */}
                    <input
                      type="text"
                      list={`available-fields-${idx}`}
                      value={rule.field}
                      onChange={(e) => handleKeyRowChange(idx, { field: e.target.value })}
                      placeholder="Field name"
                      required
                      className="index-modal-key-field"
                    />
                    <datalist id={`available-fields-${idx}`}>
                      {availableFields.map(f => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>

                    <div className="index-modal-key-divider" />

                    {/* Direction Dropdown */}
                    <select
                      value={rule.direction}
                      onChange={(e) => handleKeyRowChange(idx, { direction: parseInt(e.target.value, 10) as 1 | -1 })}
                      className="index-modal-key-select"
                    >
                      <option value={1}>Ascending (1)</option>
                      <option value={-1}>Descending (-1)</option>
                    </select>

                    <div className="index-modal-key-divider" />

                    {/* Delete row */}
                    <button
                      type="button"
                      disabled={keysList.length <= 1}
                      onClick={() => handleRemoveKeyRow(idx)}
                      className="index-modal-btn-delete"
                      title="Remove Key"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={handleAddKeyRow}
                  className="index-modal-btn-add"
                >
                  <Plus size={12} />
                  <span>Add Index Key</span>
                </button>
              </div>
            ) : (
              /* Raw JSON Editor Mode */
              <div className="flex flex-col">
                <textarea
                  value={rawKeysJson}
                  onChange={(e) => setRawKeysJson(e.target.value)}
                  rows={4}
                  className="index-modal-textarea"
                  placeholder='{ "email": 1 }'
                />
              </div>
            )}
          </div>

          {/* Premium Constraint Cards */}
          <div className="index-modal-constraints-grid">
            <div 
              onClick={() => setUnique(!unique)}
              className={`index-modal-constraint-card ${unique ? 'active' : ''}`}
            >
              <div className="constraint-card-info">
                <span className="constraint-card-title">Unique Index</span>
                <span className="constraint-card-desc">Prevent duplicates</span>
              </div>
              <input
                type="checkbox"
                checked={unique}
                onChange={() => {}} // onClick handles toggling
                className="index-modal-checkbox"
                data-testid="unique-checkbox"
              />
            </div>

            <div 
              onClick={() => setSparse(!sparse)}
              className={`index-modal-constraint-card ${sparse ? 'active' : ''}`}
            >
              <div className="constraint-card-info">
                <span className="constraint-card-title">Sparse Index</span>
                <span className="constraint-card-desc">Ignore missing keys</span>
              </div>
              <input
                type="checkbox"
                checked={sparse}
                onChange={() => {}} // onClick handles toggling
                className="index-modal-checkbox"
                data-testid="sparse-checkbox"
              />
            </div>
          </div>

          {/* Error Message */}
          {jsonError && (
            <div className="index-modal-error">
              {jsonError}
            </div>
          )}

          {/* Modal Footer Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3">
            <button
              type="button"
              onClick={onClose}
              className="index-modal-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="index-modal-btn-primary"
              data-testid="save-index-btn"
            >
              {initialData ? 'Save Changes' : 'Create Index'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
