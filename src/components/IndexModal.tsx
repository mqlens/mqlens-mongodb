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
import { useTranslation } from 'react-i18next';
import {
  appliesTo,
  emptyIndexForm,
  formFromSpec,
  INDEX_OPTIONS,
  parseObject,
  specFromForm,
  type IndexDocument,
  type IndexKeyType,
  type IndexProblem,
  type OptionField,
} from '../lib/indexSpec';

interface IndexKeyRule {
  id: string;
  field: string;
  direction: IndexKeyType;
}

const KEY_TYPES: IndexKeyType[] = [1, -1, 'text', '2dsphere', '2d', 'hashed'];

const asKeyType = (value: unknown): IndexKeyType =>
  KEY_TYPES.find((type) => String(type) === String(value)) ?? 1;

const newKeyRule = (field = '_id', direction: IndexKeyType = 1): IndexKeyRule => ({
  id: Math.random().toString(36).slice(2, 11),
  field,
  direction,
});

const rulesFor = (keys: Record<string, unknown>): IndexKeyRule[] =>
  Object.entries(keys).map(([field, type]) => newKeyRule(field, asKeyType(type)));

const OPTION_PLACEHOLDERS: Partial<Record<OptionField, string>> = {
  partialFilterExpression: '{ "status": "active" }',
  collation: '{ "locale": "en", "strength": 2 }',
  storageEngine: '{ "wiredTiger": { "configString": "block_compressor=zstd" } }',
  weights: '{ "title": 10, "body": 1 }',
  defaultLanguage: 'english',
  languageOverride: 'language',
  textIndexVersion: '3',
  sphereIndexVersion: '3',
  bits: '26',
  min: '-180',
  max: '180',
  wildcardProjection: '{ "tags": 1 }',
};

const sortFieldNames = (fields: Iterable<string>): string[] =>
  Array.from(new Set(fields)).sort((a, b) => {
    if (a === '_id') return -1;
    if (b === '_id') return 1;
    return a.localeCompare(b);
  });

interface IndexModalProps {
  isOpen: boolean;
  onClose: () => void;
  // The whole index document, and a commit quorum if one was given.
  onSave: (spec: IndexDocument, commitQuorum: string | null) => void;
  availableFields?: string[];
  connectionId?: string;
  databaseName?: string;
  collectionName?: string;
  // The index being edited. What the form has no field for stays as it is.
  initialData?: IndexDocument | null;
  // MQLens Server has no field for a commit quorum yet.
  allowCommitQuorum?: boolean;
  // Pre-fills the create-mode form (e.g. from a COLLSCAN index suggestion).
  // Ignored when initialData is set (edit mode) — unique/sparse always start false.
  prefill?: {
    name: string;
    keys: Record<string, number>;
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

// MongoDB keeps a TTL as a 32-bit integer.
const TTL_MAX = 2147483647;

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
  allowCommitQuorum = true,
  prefill,
}) => {
  const { t } = useTranslation('admin');
  const [indexName, setIndexName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [isRawMode, setIsRawMode] = useState(false);
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState('');
  const [keysList, setKeysList] = useState<IndexKeyRule[]>([newKeyRule()]);
  const [rawKeysJson, setRawKeysJson] = useState('{\n  "_id": 1\n}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Hidden and the options; the fields above keep the rest of the form.
  const [form, setForm] = useState(emptyIndexForm);
  const [commitQuorum, setCommitQuorum] = useState('');

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
      Object.keys(formFromSpec(initialData).keys).forEach((f) => names.add(f));
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
      setForm(emptyIndexForm());
      setCommitQuorum('');
      if (initialData) {
        const editing = formFromSpec(initialData);
        setForm(editing);
        setIndexName(editing.name);
        setUnique(editing.unique);
        setSparse(editing.sparse);
        setTtl(editing.ttlSeconds !== null);
        setTtlSeconds(editing.ttlSeconds !== null ? String(editing.ttlSeconds) : '');
        const list = rulesFor(editing.keys);
        setKeysList(list.length > 0 ? list : [newKeyRule()]);
        setRawKeysJson(JSON.stringify(editing.keys, null, 2));
      } else if (prefill && Object.keys(prefill.keys).length > 0) {
        setIndexName(prefill.name);
        setUnique(false);
        setSparse(false);
        setTtl(false);
        setTtlSeconds('');
        setKeysList(rulesFor(prefill.keys));
        setRawKeysJson(JSON.stringify(prefill.keys, null, 2));
      } else {
        setIndexName('');
        setUnique(false);
        setSparse(false);
        setTtl(false);
        setTtlSeconds('');
        setKeysList([newKeyRule()]);
        setRawKeysJson('{\n  "_id": 1\n}');
      }
      setJsonError(null);
      setIsRawMode(false);
      setNameTouched(false);
    }
  }, [isOpen, initialData, prefill]);

  useEffect(() => {
    if (!isOpen || initialData || prefill || nameTouched) return;
    setIndexName(defaultIndexName(rawKeysJson));
  }, [isOpen, initialData, prefill, nameTouched, rawKeysJson]);

  useEffect(() => {
    if (!isRawMode) {
      const keysObj: Record<string, IndexKeyType> = {};
      keysList.forEach((k) => {
        if (k.field.trim()) {
          keysObj[k.field.trim()] = k.direction;
        }
      });
      setRawKeysJson(JSON.stringify(keysObj, null, 2));
    }
  }, [keysList, isRawMode]);

  // In step with the builder through the effect above.
  const currentKeys = useMemo(() => parseObject(rawKeysJson), [rawKeysJson]);

  const optionLabels: Record<OptionField, string> = {
    partialFilterExpression: t('indexModal.optionLabels.partialFilterExpression'),
    collation: t('indexModal.optionLabels.collation'),
    storageEngine: t('indexModal.optionLabels.storageEngine'),
    weights: t('indexModal.optionLabels.weights'),
    defaultLanguage: t('indexModal.optionLabels.defaultLanguage'),
    languageOverride: t('indexModal.optionLabels.languageOverride'),
    textIndexVersion: t('indexModal.optionLabels.textIndexVersion'),
    sphereIndexVersion: t('indexModal.optionLabels.sphereIndexVersion'),
    bits: t('indexModal.optionLabels.bits'),
    min: t('indexModal.optionLabels.min'),
    max: t('indexModal.optionLabels.max'),
    wildcardProjection: t('indexModal.optionLabels.wildcardProjection'),
  };

  const describeProblem = ({ key, params }: IndexProblem): string =>
    ({
      collationNotSupported: t('indexModal.errors.collationNotSupported'),
      compoundWildcardNeedsProjection: t('indexModal.errors.compoundWildcardNeedsProjection'),
      hashedOneField: t('indexModal.errors.hashedOneField'),
      hashedUnique: t('indexModal.errors.hashedUnique'),
      optionNotJson: t('indexModal.errors.optionNotJson', params),
      optionNotNumber: t('indexModal.errors.optionNotNumber', params),
      partialExistsFalse: t('indexModal.errors.partialExistsFalse'),
      partialOperator: t('indexModal.errors.partialOperator', params),
      partialWithSparse: t('indexModal.errors.partialWithSparse'),
      wildcardProjectionNeedsAllFields: t('indexModal.errors.wildcardProjectionNeedsAllFields'),
      wildcardSparse: t('indexModal.errors.wildcardSparse'),
      wildcardTtl: t('indexModal.errors.wildcardTtl'),
      wildcardUnique: t('indexModal.errors.wildcardUnique'),
    })[key] ?? key;

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
          throw new Error(t('indexModal.errors.keysMustBeObject'));
        }
        Object.entries(parsed).forEach(([key, val]) => {
          if (!KEY_TYPES.includes(val as IndexKeyType)) {
            throw new Error(t('indexModal.errors.invalidDirection', { field: key }));
          }
        });
        keysJsonStr = JSON.stringify(parsed);
      } catch (err: any) {
        setJsonError(err.message || t('indexModal.errors.invalidJsonSyntax'));
        return;
      }
    } else {
      const keysObj: Record<string, IndexKeyType> = {};
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
        setJsonError(t('indexModal.errors.allFieldsNeedName'));
        return;
      }

      if (Object.keys(keysObj).length === 0) {
        setJsonError(t('indexModal.errors.specifyAtLeastOneKey'));
        return;
      }

      keysJsonStr = JSON.stringify(keysObj);
    }

    const trimmedName = indexName.trim();
    if (!trimmedName) {
      setJsonError(t('indexModal.errors.nameRequired'));
      return;
    }

    // MongoDB's rules for a TTL index; the backend checks them again.
    let expireAfterSeconds: number | null = null;
    if (ttl) {
      const fields = Object.keys(JSON.parse(keysJsonStr));
      if (fields.length !== 1) {
        setJsonError(t('indexModal.errors.ttlSingleField'));
        return;
      }
      if (fields[0] === '_id') {
        setJsonError(t('indexModal.errors.ttlNotId'));
        return;
      }
      const seconds = ttlSeconds.trim();
      if (!/^\d+$/.test(seconds) || Number(seconds) > TTL_MAX) {
        setJsonError(t('indexModal.errors.ttlRange'));
        return;
      }
      expireAfterSeconds = Number(seconds);
    }

    const made = specFromForm(
      { ...form, name: trimmedName, keys: JSON.parse(keysJsonStr), unique, sparse, ttlSeconds: expireAfterSeconds },
      initialData ?? undefined
    );
    if (made.problem) {
      setJsonError(describeProblem(made.problem));
      return;
    }
    onSave(made.spec, (allowCommitQuorum && commitQuorum.trim()) || null);
  };

  const switchToBuilder = () => {
    if (isRawMode) {
      try {
        const list = rulesFor(JSON.parse(rawKeysJson));
        if (list.length > 0) setKeysList(list);
      } catch {
        /* keep current list */
      }
      setIsRawMode(false);
    }
  };

  const switchToRaw = () => {
    if (!isRawMode) {
      const keysObj: Record<string, IndexKeyType> = {};
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
        defaultHeight={600}
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
            {initialData ? t('indexModal.titleEdit') : t('indexModal.titleCreate')}
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label={t('indexModal.closeAriaLabel')}>
            <X size={13} />
          </Button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {initialData && (
              <p className="text-[11px] text-muted-foreground" data-testid="index-rebuild-hint">
                {t('indexModal.hints.rebuild')}
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="index-name-input">{t('indexModal.labels.indexName')}</Label>
              <Input
                id="index-name-input"
                type="text"
                value={indexName}
                onChange={(e) => {
                  setIndexName(e.target.value);
                  setNameTouched(e.target.value !== '');
                }}
                placeholder={t('indexModal.placeholders.indexName')}
                required
                data-testid="index-name-input"
              />
              <span className="text-[11px] text-muted-foreground">
                {t('indexModal.hints.autoGenerated')}
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('indexModal.labels.indexKeyDefinition')}</Label>
              <Tabs value={isRawMode ? 'raw' : 'builder'}>
                <TabsList className="h-8">
                  <TabsTrigger value="builder" className="text-xs" onClick={switchToBuilder}>
                    <Layers size={12} className="mr-1" />
                    {t('indexModal.tabs.keyBuilder')}
                  </TabsTrigger>
                  <TabsTrigger value="raw" className="text-xs" onClick={switchToRaw}>
                    <Code size={12} className="mr-1" />
                    {t('indexModal.tabs.rawJson')}
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
                              placeholder={t('indexModal.placeholders.fieldPath')}
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
                                {t('indexModal.actions.list')}
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
                            {!fieldOptions.includes('$**') && (
                              <option value="$**">{t('indexModal.options.wildcardField')}</option>
                            )}
                            <option value="__custom__">{t('indexModal.options.customField')}</option>
                          </select>
                        )}
                        <select
                          value={String(rule.direction)}
                          onChange={(e) =>
                            handleKeyRowChange(idx, { direction: asKeyType(e.target.value) })
                          }
                          className="h-9 w-[150px] shrink-0 rounded-md border border-input bg-background px-2 text-sm"
                          data-testid={`index-key-direction-${idx}`}
                        >
                          <option value="1">{t('indexModal.options.ascending')}</option>
                          <option value="-1">{t('indexModal.options.descending')}</option>
                          <option value="text">{t('indexModal.options.text')}</option>
                          <option value="2dsphere">2dsphere</option>
                          <option value="2d">2d</option>
                          <option value="hashed">{t('indexModal.options.hashed')}</option>
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          disabled={keysList.length <= 1}
                          onClick={() => handleRemoveKeyRow(idx)}
                          title={t('indexModal.actions.removeKey')}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    );
                    })}
                  </div>
                  <Button type="button" variant="outline" size="sm" className="w-fit text-xs" onClick={handleAddKeyRow}>
                    <Plus size={12} />
                    {t('indexModal.actions.addIndexKey')}
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
              <Label>{t('indexModal.labels.constraints')}</Label>
              <div className="flex flex-wrap gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={unique}
                    onChange={() => setUnique((v) => !v)}
                    data-testid="unique-checkbox"
                    className="rounded border-input"
                  />
                  <span>{t('indexModal.constraintLabels.unique')}</span>
                  <span className="text-muted-foreground">{t('indexModal.constraintLabels.uniqueHint')}</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={sparse}
                    onChange={() => setSparse((v) => !v)}
                    data-testid="sparse-checkbox"
                    className="rounded border-input"
                  />
                  <span>{t('indexModal.constraintLabels.sparse')}</span>
                  <span className="text-muted-foreground">{t('indexModal.constraintLabels.sparseHint')}</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={form.hidden}
                    onChange={() => setForm((f) => ({ ...f, hidden: !f.hidden }))}
                    data-testid="hidden-checkbox"
                    className="rounded border-input"
                  />
                  <span>{t('indexModal.constraintLabels.hidden')}</span>
                  <span className="text-muted-foreground">{t('indexModal.constraintLabels.hiddenHint')}</span>
                </label>
                <div className="flex items-center gap-2 text-xs text-foreground">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ttl}
                      onChange={() => setTtl((v) => !v)}
                      data-testid="ttl-checkbox"
                      className="rounded border-input"
                    />
                    <span>{t('indexModal.constraintLabels.ttl')}</span>
                  </label>
                  {/* No min/max/step: the browser's own validation would block
                      the submit before the app could say what is wrong. */}
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={ttlSeconds}
                    onChange={(e) => setTtlSeconds(e.target.value)}
                    disabled={!ttl}
                    aria-label={t('indexModal.constraintLabels.ttlSeconds')}
                    className="h-7 w-28 text-xs"
                    data-testid="ttl-seconds-input"
                  />
                  <span className="text-muted-foreground">{t('indexModal.constraintLabels.ttlUnit')}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('indexModal.labels.options')}</Label>
              {INDEX_OPTIONS.filter(({ needs }) => appliesTo(needs, currentKeys)).map(({ field, parse }) => (
                <div key={field} className="flex flex-col gap-1">
                  <label htmlFor={`index-option-${field}`} className="text-[11px] text-muted-foreground">
                    {optionLabels[field]}
                  </label>
                  {parse === 'json' ? (
                    <textarea
                      id={`index-option-${field}`}
                      value={form[field]}
                      onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                      rows={2}
                      className={cn(textareaClassName, 'min-h-[56px]')}
                      placeholder={OPTION_PLACEHOLDERS[field]}
                      data-testid={`index-option-${field}`}
                    />
                  ) : (
                    <Input
                      id={`index-option-${field}`}
                      value={form[field]}
                      onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                      className="h-8 font-mono text-xs"
                      placeholder={OPTION_PLACEHOLDERS[field]}
                      data-testid={`index-option-${field}`}
                    />
                  )}
                </div>
              ))}
              {allowCommitQuorum && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="index-commit-quorum" className="text-[11px] text-muted-foreground">
                    {t('indexModal.optionLabels.commitQuorum')}
                  </label>
                  <Input
                    id="index-commit-quorum"
                    value={commitQuorum}
                    onChange={(e) => setCommitQuorum(e.target.value)}
                    className="h-8 font-mono text-xs"
                    placeholder="votingMembers"
                    data-testid="index-commit-quorum"
                  />
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="border-t border-border px-4 py-3 sm:justify-between">
            <span className="min-w-0 text-[11px] text-destructive">{jsonError}</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t('indexModal.actions.cancel')}
              </Button>
              <Button type="submit" data-testid="save-index-btn">
                {initialData ? t('indexModal.actions.saveChanges') : t('indexModal.actions.createIndex')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DraggableDialogContent>
    </Dialog>
  );
};
