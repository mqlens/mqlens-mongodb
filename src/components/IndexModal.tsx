import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Code, Layers, ChevronDown } from 'lucide-react';
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

// MongoDB's default index name: the key fields joined as `field_direction`
// (e.g. { email: 1, status: -1 } → "email_1_status_-1").
const defaultIndexName = (json: string): string => {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
    return Object.entries(parsed)
      .filter(([field]) => field.trim())
      .map(([field, dir]) => `${field.trim()}_${dir}`)
      .join('_');
  } catch {
    return '';
  }
};

export const IndexModal: React.FC<IndexModalProps> = ({
  isOpen,
  onClose,
  onSave,
  availableFields,
  initialData,
}) => {
  const [indexName, setIndexName] = useState('');
  // Whether the user typed a custom name; until then the name is generated
  // from the keys per the Mongo convention.
  const [nameTouched, setNameTouched] = useState(false);
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
      setNameTouched(false);
    }
  }, [isOpen, initialData]);

  // Auto-name the index from its keys until the user types a custom name;
  // clearing the field hands naming back to the generator. Existing indexes
  // keep their stored name.
  useEffect(() => {
    if (!isOpen || initialData || nameTouched) return;
    setIndexName(defaultIndexName(rawKeysJson));
  }, [isOpen, initialData, nameTouched, rawKeysJson]);

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
    // No click-outside close: dismiss only via the X button, Cancel, or Escape.
    <div className="nested-modal-overlay mql-modal-overlay select-none" data-testid="index-modal">
      <div className="nested-modal-container mql-ncd" style={{ width: 560, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header className="mql-ncd-titlebar">
          <div className="mql-row" style={{ gap: 8 }}>
            <Layers size={14} className="text-[var(--accent-blue)]" />
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {initialData ? 'Edit Index definition' : 'Create New Index'}
            </span>
          </div>
          <button type="button" className="mql-icon-btn" onClick={onClose} aria-label="Close modal">
            <X size={13} />
          </button>
        </header>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div
            className="mql-ncd-body"
            style={{ flex: 1, minHeight: 0, padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}
          >
          {/* Index Name Input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label className="mql-label">Index Name</label>
            <input
              type="text"
              value={indexName}
              onChange={(e) => {
                setIndexName(e.target.value);
                setNameTouched(e.target.value !== '');
              }}
              placeholder="e.g. email_1_status_-1"
              required
              className="mql-ncd-input"
              data-testid="index-name-input"
            />
            <span className="mql-ncd-fhint">
              Auto-generated from the keys (Mongo convention) — type to override.
            </span>
          </div>

          {/* Keys Specification */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="mql-label">Index Key Definition</label>

            {/* Builder / raw JSON mode tabs (same control as the connection dialog) */}
            <nav className="mql-ncd-tabs">
              <button
                type="button"
                className={`mql-ncd-tab ${!isRawMode ? 'is-active' : ''}`}
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
                <Layers size={12} style={{ marginRight: 4 }} />
                <span>Key Builder</span>
              </button>
              <button
                type="button"
                className={`mql-ncd-tab ${isRawMode ? 'is-active' : ''}`}
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
                <Code size={12} style={{ marginRight: 4 }} />
                <span>Raw JSON</span>
              </button>
            </nav>

            {/* Builder Mode */}
            {!isRawMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Cap at ~5 rows; longer key lists scroll instead of growing the dialog. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 170, overflowY: 'auto', paddingRight: 2 }}>
                {keysList.map((rule, idx) => (
                  <div key={idx} className="mql-row" style={{ gap: 6 }}>
                    {/* Unified row input */}
                    <input
                      type="text"
                      list={`available-fields-${idx}`}
                      value={rule.field}
                      onChange={(e) => handleKeyRowChange(idx, { field: e.target.value })}
                      placeholder="Field name"
                      required
                      className="mql-ncd-input"
                      style={{ flex: 1 }}
                    />
                    <datalist id={`available-fields-${idx}`}>
                      {availableFields.map(f => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>

                    {/* Direction Dropdown */}
                    <div className="mql-ncd-select-wrap" style={{ width: 150 }}>
                      <select
                        value={rule.direction}
                        onChange={(e) => handleKeyRowChange(idx, { direction: parseInt(e.target.value, 10) as 1 | -1 })}
                        className="mql-ncd-select"
                      >
                        <option value={1}>Ascending (1)</option>
                        <option value={-1}>Descending (-1)</option>
                      </select>
                      <ChevronDown size={10} color="var(--text-dim)" />
                    </div>

                    {/* Delete row */}
                    <button
                      type="button"
                      disabled={keysList.length <= 1}
                      onClick={() => handleRemoveKeyRow(idx)}
                      className="mql-icon-btn mql-icon-btn-danger"
                      title="Remove Key"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                </div>
                <button
                  type="button"
                  onClick={handleAddKeyRow}
                  className="mql-btn mql-btn-ghost mql-btn-outlined"
                  style={{ alignSelf: 'flex-start', padding: '4px 8px', fontSize: 11 }}
                >
                  <Plus size={12} style={{ marginRight: 4 }} />
                  <span>Add Index Key</span>
                </button>
              </div>
            ) : (
              /* Raw JSON Editor Mode */
              <textarea
                value={rawKeysJson}
                onChange={(e) => setRawKeysJson(e.target.value)}
                rows={4}
                className="mql-ncd-textarea font-mono"
                placeholder='{ "email": 1 }'
              />
            )}
          </div>

          {/* Constraints */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="mql-label">Constraints</label>
            <div className="mql-row" style={{ gap: 20 }}>
              <label className="mql-row" style={{ gap: 6, cursor: 'pointer', fontSize: 11.5, color: 'var(--text-main)' }}>
                <input
                  type="checkbox"
                  checked={unique}
                  onChange={() => setUnique(v => !v)}
                  data-testid="unique-checkbox"
                />
                <span>Unique</span>
                <span className="mql-ncd-fhint">prevent duplicates</span>
              </label>
              <label className="mql-row" style={{ gap: 6, cursor: 'pointer', fontSize: 11.5, color: 'var(--text-main)' }}>
                <input
                  type="checkbox"
                  checked={sparse}
                  onChange={() => setSparse(v => !v)}
                  data-testid="sparse-checkbox"
                />
                <span>Sparse</span>
                <span className="mql-ncd-fhint">ignore missing keys</span>
              </label>
            </div>
          </div>
          </div>

          {/* Modal Footer Actions */}
          <footer className="mql-ncd-foot">
            <span style={{ color: 'var(--accent-red)', fontSize: 11, minWidth: 0 }}>{jsonError}</span>
            <div className="mql-row" style={{ gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                className="mql-btn mql-btn-ghost mql-btn-outlined"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="mql-btn mql-btn-primary"
                data-testid="save-index-btn"
              >
                {initialData ? 'Save Changes' : 'Create Index'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
};
