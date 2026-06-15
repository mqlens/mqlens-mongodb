import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2, Code, Layers, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCollectionSchema } from '../lib/useCollectionSchema';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useEscapeClose } from '../lib/useEscapeClose';

interface IndexKeyRule {
  id: string;
  field: string;
  direction: 1 | -1;
}

const newKeyRule = (field = '_id', direction: 1 | -1 = 1): IndexKeyRule => ({
  id: Math.random().toString(36).slice(2, 11),
  field,
  direction,
});

const sortFieldNames = (fields: Iterable<string>): string[] =>
  Array.from(new Set(fields)).sort((a, b) => {
    if (a === '_id') return -1;
    if (b === '_id') return 1;
    return a.localeCompare(b);
  });

interface IndexModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (indexName: string, keys: string, unique: boolean, sparse: boolean) => void;
  availableFields?: string[];
  connectionId?: string;
  databaseName?: string;
  collectionName?: string;
  initialData?: {
    name: string;
    keys: Record<string, number>;
    unique: boolean;
    sparse: boolean;
  } | null;
}

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

const textareaClassName = cn(
  'flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm transition-colors',
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
);

export const IndexModal: React.FC<IndexModalProps> = ({
  isOpen,
  onClose,
  onSave,
  availableFields = [],
  connectionId,
  databaseName,
  collectionName,
  initialData,
}) => {
  const [indexName, setIndexName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [isRawMode, setIsRawMode] = useState(false);
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [keysList, setKeysList] = useState<IndexKeyRule[]>([newKeyRule()]);
  const [rawKeysJson, setRawKeysJson] = useState('{\n  "_id": 1\n}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const { schema } = useCollectionSchema(
    isOpen ? connectionId : undefined,
    isOpen ? databaseName : undefined,
    isOpen ? collectionName : undefined
  );

  const fieldOptions = useMemo(() => {
    const names = new Set<string>(['_id']);
    availableFields.forEach((f) => names.add(f));
    schema.forEach((_, path) => names.add(path));
    if (initialData) {
      Object.keys(initialData.keys).forEach((f) => names.add(f));
    }
    keysList.forEach((k) => {
      const trimmed = k.field.trim();
      if (trimmed && trimmed !== '__custom__') names.add(trimmed);
    });
    return sortFieldNames(names);
  }, [availableFields, schema, initialData, keysList]);

  useEscapeClose(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setIndexName(initialData.name);
        setUnique(initialData.unique);
        setSparse(initialData.sparse);
        const list: IndexKeyRule[] = Object.entries(initialData.keys).map(([field, dir]) =>
          newKeyRule(field, dir === -1 ? -1 : 1)
        );
        setKeysList(list.length > 0 ? list : [newKeyRule()]);
        setRawKeysJson(JSON.stringify(initialData.keys, null, 2));
      } else {
        setIndexName('');
        setUnique(false);
        setSparse(false);
        setKeysList([newKeyRule()]);
        setRawKeysJson('{\n  "_id": 1\n}');
      }
      setJsonError(null);
      setIsRawMode(false);
      setNameTouched(false);
    }
  }, [isOpen, initialData]);

  useEffect(() => {
    if (!isOpen || initialData || nameTouched) return;
    setIndexName(defaultIndexName(rawKeysJson));
  }, [isOpen, initialData, nameTouched, rawKeysJson]);

  useEffect(() => {
    if (!isRawMode) {
      const keysObj: Record<string, number> = {};
      keysList.forEach((k) => {
        if (k.field.trim()) {
          keysObj[k.field.trim()] = k.direction;
        }
      });
      setRawKeysJson(JSON.stringify(keysObj, null, 2));
    }
  }, [keysList, isRawMode]);

  const handleAddKeyRow = () => {
    const addedFields = new Set(keysList.map((k) => k.field.trim()).filter(Boolean));
    const nextField = fieldOptions.find((f) => !addedFields.has(f)) ?? '';
    setKeysList((prev) => [...prev, newKeyRule(nextField)]);
  };

  const handleRemoveKeyRow = (index: number) => {
    if (keysList.length <= 1) return;
    setKeysList((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyRowChange = (index: number, updates: Partial<IndexKeyRule>) => {
    setKeysList((prev) => prev.map((k, i) => (i === index ? { ...k, ...updates } : k)));
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

      keysList.forEach((k) => {
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

  const switchToBuilder = () => {
    if (isRawMode) {
      try {
        const parsed = JSON.parse(rawKeysJson);
        const list: IndexKeyRule[] = Object.entries(parsed).map(([field, dir]) =>
          newKeyRule(field, dir === -1 ? -1 : 1)
        );
        if (list.length > 0) setKeysList(list);
      } catch {
        /* keep current list */
      }
      setIsRawMode(false);
    }
  };

  const switchToRaw = () => {
    if (!isRawMode) {
      const keysObj: Record<string, number> = {};
      keysList.forEach((k) => {
        if (k.field.trim()) {
          keysObj[k.field.trim()] = k.direction;
        }
      });
      setRawKeysJson(JSON.stringify(keysObj, null, 2));
      setIsRawMode(true);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DraggableDialogContent
        resetKey={isOpen}
        defaultWidth={560}
        defaultHeight={520}
        minWidth={440}
        minHeight={360}
        hideClose
        className="flex min-h-0 flex-col gap-0 p-0"
        data-testid="index-modal"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <DialogHeader
          data-dialog-drag-handle
          className="flex cursor-grab flex-row items-center justify-between border-b border-border px-4 py-3 active:cursor-grabbing"
        >
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Layers size={14} className="text-primary" />
            {initialData ? 'Edit Index definition' : 'Create New Index'}
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close modal">
            <X size={13} />
          </Button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="index-name-input">Index Name</Label>
              <Input
                id="index-name-input"
                type="text"
                value={indexName}
                onChange={(e) => {
                  setIndexName(e.target.value);
                  setNameTouched(e.target.value !== '');
                }}
                placeholder="e.g. email_1_status_-1"
                required
                data-testid="index-name-input"
              />
              <span className="text-[11px] text-muted-foreground">
                Auto-generated from the keys (Mongo convention) — type to override.
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Index Key Definition</Label>
              <Tabs value={isRawMode ? 'raw' : 'builder'}>
                <TabsList className="h-8">
                  <TabsTrigger value="builder" className="text-xs" onClick={switchToBuilder}>
                    <Layers size={12} className="mr-1" />
                    Key Builder
                  </TabsTrigger>
                  <TabsTrigger value="raw" className="text-xs" onClick={switchToRaw}>
                    <Code size={12} className="mr-1" />
                    Raw JSON
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {!isRawMode ? (
                <div className="flex flex-col gap-2">
                  <div className="flex max-h-[170px] flex-col gap-2 overflow-y-auto pr-1">
                    {keysList.map((rule, idx) => {
                      const isCustomField =
                        rule.field === '__custom__' || !fieldOptions.includes(rule.field);
                      return (
                      <div key={rule.id} className="flex items-center gap-2">
                        {isCustomField ? (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <Input
                              type="text"
                              value={rule.field === '__custom__' ? '' : rule.field}
                              onChange={(e) => handleKeyRowChange(idx, { field: e.target.value })}
                              placeholder="field.path"
                              required
                              className="min-w-0 flex-1 font-mono text-sm"
                              data-testid={`index-key-field-${idx}`}
                            />
                            {fieldOptions.length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 shrink-0 px-2 text-xs"
                                onClick={() => handleKeyRowChange(idx, { field: fieldOptions[0] })}
                              >
                                List
                              </Button>
                            )}
                          </div>
                        ) : (
                          <select
                            value={rule.field}
                            onChange={(e) => {
                              const value = e.target.value;
                              handleKeyRowChange(idx, {
                                field: value === '__custom__' ? '__custom__' : value,
                              });
                            }}
                            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                            data-testid={`index-key-field-${idx}`}
                          >
                            {fieldOptions.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                            <option value="__custom__">Custom field…</option>
                          </select>
                        )}
                        <select
                          value={String(rule.direction)}
                          onChange={(e) =>
                            handleKeyRowChange(idx, { direction: parseInt(e.target.value, 10) as 1 | -1 })
                          }
                          className="h-9 w-[150px] shrink-0 rounded-md border border-input bg-background px-2 text-sm"
                          data-testid={`index-key-direction-${idx}`}
                        >
                          <option value="1">Ascending (1)</option>
                          <option value="-1">Descending (-1)</option>
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          disabled={keysList.length <= 1}
                          onClick={() => handleRemoveKeyRow(idx)}
                          title="Remove Key"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    );
                    })}
                  </div>
                  <Button type="button" variant="outline" size="sm" className="w-fit text-xs" onClick={handleAddKeyRow}>
                    <Plus size={12} />
                    Add Index Key
                  </Button>
                </div>
              ) : (
                <textarea
                  value={rawKeysJson}
                  onChange={(e) => setRawKeysJson(e.target.value)}
                  rows={4}
                  className={textareaClassName}
                  placeholder='{ "email": 1 }'
                />
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label>Constraints</Label>
              <div className="flex flex-wrap gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={unique}
                    onChange={() => setUnique((v) => !v)}
                    data-testid="unique-checkbox"
                    className="rounded border-input"
                  />
                  <span>Unique</span>
                  <span className="text-muted-foreground">prevent duplicates</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={sparse}
                    onChange={() => setSparse((v) => !v)}
                    data-testid="sparse-checkbox"
                    className="rounded border-input"
                  />
                  <span>Sparse</span>
                  <span className="text-muted-foreground">ignore missing keys</span>
                </label>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border px-4 py-3 sm:justify-between">
            <span className="min-w-0 text-[11px] text-destructive">{jsonError}</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" data-testid="save-index-btn">
                {initialData ? 'Save Changes' : 'Create Index'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DraggableDialogContent>
    </Dialog>
  );
};
