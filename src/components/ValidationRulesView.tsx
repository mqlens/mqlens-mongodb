import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ShieldCheck, Loader2, AlertCircle, CheckCircle2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QueryEditor } from './QueryEditor';
import { useTranslation } from 'react-i18next';
import { validatorFromSchemaReport, type SchemaReport } from '@/lib/schemaReport';

interface ValidationRulesViewProps {
  connectionId: string;
  databaseName: string;
  collectionName: string;
  /** Called after a successful `set_validator` apply. */
  onApplied: () => void;
}

interface CollectionValidationUi {
  validator: string;
  validationLevel: string;
  validationAction: string;
}

const NONE_VALUE = '__none__';

export const ValidationRulesView: React.FC<ValidationRulesViewProps> = ({
  connectionId,
  databaseName,
  collectionName,
  onApplied,
}) => {
  const { t } = useTranslation('admin');
  const [validator, setValidator] = useState('{}');
  const [validationLevel, setValidationLevel] = useState('');
  const [validationAction, setValidationAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [valid, setValid] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuccess(false);
    (async () => {
      try {
        const result = await invoke<CollectionValidationUi>('get_collection_options', {
          id: connectionId,
          database: databaseName,
          collection: collectionName,
        });
        if (cancelled) return;
        setValidator(result.validator ?? '{}');
        setValidationLevel(result.validationLevel ?? '');
        setValidationAction(result.validationAction ?? '');
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, collectionName]);

  const editValidator = (v: string) => {
    setValidator(v);
    setSuccess(false);
    setValid(false);
  };

  /** Clears the messages; returns false (and shows why) if the text can't be applied. */
  const checkValidator = (): boolean => {
    setError(null);
    setSuccess(false);
    setValid(false);
    const trimmed = validator.trim();
    if (!trimmed) return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e: any) {
      setError(t('validationRulesView.errors.invalidValidatorJson', { message: e?.message || t('validationRulesView.errors.syntaxErrorFallback') }));
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError(t('validationRulesView.errors.mustBeObject'));
      return false;
    }
    return true;
  };

  const handleGenerate = async () => {
    setError(null);
    setGenerating(true);
    try {
      const json = await invoke<string>('analyze_schema', {
        id: connectionId,
        database: databaseName,
        collection: collectionName,
        sampleSize: 1000,
      });
      editValidator(JSON.stringify(validatorFromSchemaReport(JSON.parse(json) as SchemaReport), null, 2));
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = async () => {
    if (!checkValidator()) return;

    setApplying(true);
    try {
      await invoke('set_validator', {
        id: connectionId,
        database: databaseName,
        collection: collectionName,
        validator,
        validationLevel,
        validationAction,
      });
      setSuccess(true);
      onApplied();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="validation-rules-view">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        <ShieldCheck size={14} className="text-success" />
        <span>{t('validationRulesView.title', { collection: collectionName })}</span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> {t('validationRulesView.loading')}
        </div>
      ) : (
        <div className="flex max-w-[640px] flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="validation-editor">{t('validationRulesView.labels.validator')}</Label>
            <QueryEditor
              surface="filter"
              value={validator}
              onChange={editValidator}
              fields={['_id']}
              height={220}
              data-testid="validation-editor"
            />
            <p className="text-xs text-muted-foreground">
              {t('validationRulesView.hints.leaveEmptyToClear')}
            </p>
          </div>

          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label>{t('validationRulesView.labels.validationLevel')}</Label>
              <Select
                value={validationLevel || NONE_VALUE}
                onValueChange={(v) => {
                  setValidationLevel(v === NONE_VALUE ? '' : v);
                  setSuccess(false);
                }}
              >
                <SelectTrigger data-testid="validation-level-select">
                  <SelectValue placeholder={t('validationRulesView.labels.defaultOption')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>{t('validationRulesView.labels.defaultOption')}</SelectItem>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="moderate">moderate</SelectItem>
                  <SelectItem value="strict">strict</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <Label>{t('validationRulesView.labels.validationAction')}</Label>
              <Select
                value={validationAction || NONE_VALUE}
                onValueChange={(v) => {
                  setValidationAction(v === NONE_VALUE ? '' : v);
                  setSuccess(false);
                }}
              >
                <SelectTrigger data-testid="validation-action-select">
                  <SelectValue placeholder={t('validationRulesView.labels.defaultOption')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>{t('validationRulesView.labels.defaultOption')}</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div
              className="flex items-center gap-2 font-mono text-xs text-destructive"
              data-testid="validation-error"
            >
              <AlertCircle size={13} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {valid && !error && (
            <div
              className="flex items-center gap-2 font-mono text-xs text-success"
              data-testid="validation-valid"
            >
              <CheckCircle2 size={13} className="flex-shrink-0" />
              <span>{t('validationRulesView.success.valid')}</span>
            </div>
          )}

          {success && !error && (
            <div
              className="flex items-center gap-2 font-mono text-xs text-success"
              data-testid="validation-success"
            >
              <CheckCircle2 size={13} className="flex-shrink-0" />
              <span>{t('validationRulesView.success.applied')}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="validation-check-btn"
              onClick={() => setValid(checkValidator())}
            >
              {t('validationRulesView.actions.validate')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              data-testid="validation-generate-btn"
              onClick={handleGenerate}
              disabled={generating}
            >
              <Wand2 size={13} />
              {generating ? t('validationRulesView.actions.generating') : t('validationRulesView.actions.generate')}
            </Button>
            <Button
              type="button"
              data-testid="validation-apply-btn"
              onClick={handleApply}
              disabled={applying}
            >
              {applying ? t('validationRulesView.actions.applying') : t('validationRulesView.actions.apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
