import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type BulkDropPlan, type BulkDropStep, planSteps } from '@/lib/bulkDrop';

interface BulkDropDialogProps {
  connectionName: string;
  /** Fixed when the dialog opened; the selection moving on does not reach it. */
  plan: BulkDropPlan;
  run: (onUpdate: (steps: BulkDropStep[]) => void) => Promise<BulkDropStep[]>;
  onClose: () => void;
}

const StepStatus: React.FC<{ step: BulkDropStep }> = ({ step }) => {
  const { t } = useTranslation('sidebar');
  switch (step.status) {
    case 'running':
      return (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          {t('dialogs.bulkDrop.running')}
        </span>
      );
    case 'ok':
      return (
        <span className="flex items-center gap-1 text-emerald-600">
          <CheckCircle2 size={11} />
          {t('dialogs.bulkDrop.dropped')}
        </span>
      );
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-destructive">
          <XCircle size={11} />
          {t('dialogs.bulkDrop.failed')}
        </span>
      );
    default:
      return null;
  }
};

const StepRow: React.FC<{ step: BulkDropStep }> = ({ step }) => (
  <li className="flex flex-col py-0.5">
    <div className="flex items-start justify-between gap-2">
      {/* Wrapped in full: two long names with one prefix must not look the same. */}
      <span className="min-w-0 break-all font-mono">{step.coll ?? step.db}</span>
      <StepStatus step={step} />
    </div>
    {step.error && <span className="break-words text-destructive">{step.error}</span>}
  </li>
);

export const BulkDropDialog: React.FC<BulkDropDialogProps> = ({ connectionName, plan, run, onClose }) => {
  const { t } = useTranslation('sidebar');
  const [steps, setSteps] = useState(() => planSteps(plan));
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [typed, setTyped] = useState('');
  const total = steps.length;
  const canConfirm = phase === 'confirm' && typed.trim() === String(total);

  const start = async () => {
    if (!canConfirm) return;
    setPhase('running');
    try {
      setSteps(await run(setSteps));
    } catch (err) {
      // Not known to have run, so not reported as dropped.
      setSteps((prev) => prev.map((s) => (s.status === 'ok' ? s : { ...s, status: 'failed', error: `${err}` })));
    }
    setPhase('done');
  };

  const dbSteps = steps.filter((s) => s.coll === undefined);
  const collGroups = [...new Set(steps.filter((s) => s.coll !== undefined).map((s) => s.db))].map((db) => ({
    db,
    steps: steps.filter((s) => s.coll !== undefined && s.db === db),
  }));
  const failed = steps.filter((s) => s.status === 'failed').length;
  const close = () => phase !== 'running' && onClose();

  return (
    // Like DialogModal: no backdrop-click dismiss, and no dismiss at all mid-run.
    <Dialog open onOpenChange={() => {}}>
      <DialogPortal>
        <DialogOverlay className="z-[200]" />
        <DialogContent
          className="z-[200] sm:max-w-lg [&>button.absolute]:hidden"
          data-testid="bulk-drop-dialog"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('dialogs.bulkDrop.title', { count: total })}</DialogTitle>
            <DialogDescription className="flex items-start gap-2 font-medium text-destructive">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t('dialogs.bulkDrop.warning', { connection: connectionName })}</span>
            </DialogDescription>
          </DialogHeader>

          {/* Everything that grows with the selection scrolls here, so the field and buttons stay on screen. */}
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-2 text-xs" data-testid="bulk-drop-list">
            {dbSteps.length > 0 && (
              <section>
                <h4 className="break-all font-semibold">{t('dialogs.bulkDrop.databases', { n: dbSteps.length })}</h4>
                <ul className="pl-2">
                  {dbSteps.map((s) => (
                    <StepRow key={s.db} step={s} />
                  ))}
                </ul>
              </section>
            )}
            {collGroups.map((g) => (
              <section key={g.db}>
                <h4 className="break-all font-semibold">
                  {t('dialogs.bulkDrop.collectionsIn', { db: g.db, n: g.steps.length })}
                </h4>
                <ul className="pl-2">
                  {g.steps.map((s) => (
                    <StepRow key={s.coll} step={s} />
                  ))}
                </ul>
              </section>
            ))}
            {plan.covered.length > 0 && (
              <p className="break-all text-muted-foreground" data-testid="bulk-drop-covered">
                {t('dialogs.bulkDrop.covered', {
                  names: plan.covered.flatMap((g) => g.names.map((n) => `${g.db}.${n}`)).join(', '),
                })}
              </p>
            )}
            {plan.excluded.length > 0 && (
              <p className="break-all text-muted-foreground" data-testid="bulk-drop-excluded">
                {t('dialogs.bulkDrop.excluded', { names: plan.excluded.join(', ') })}
              </p>
            )}
          </div>

          {phase === 'confirm' ? (
            <label className="flex flex-col gap-1 text-xs">
              {t('dialogs.bulkDrop.typeCount', { n: total })}
              <Input
                autoFocus
                inputMode="numeric"
                data-testid="bulk-drop-confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void start();
                  }
                }}
              />
            </label>
          ) : (
            phase === 'done' && (
              <p className={failed ? 'text-sm text-destructive' : 'text-sm'} data-testid="bulk-drop-summary">
                {failed
                  ? t('dialogs.bulkDrop.summaryFailed', { failed, n: total })
                  : t('dialogs.bulkDrop.summaryOk', { count: total })}
              </p>
            )
          )}

          <DialogFooter>
            {phase === 'confirm' ? (
              <>
                <Button type="button" variant="ghost" data-testid="bulk-drop-cancel" onClick={onClose}>
                  {t('common:cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="bulk-drop-confirm"
                  disabled={!canConfirm}
                  onClick={() => void start()}
                >
                  {t('dialogs.bulkDrop.confirm', { count: total })}
                </Button>
              </>
            ) : (
              <Button type="button" data-testid="bulk-drop-close" disabled={phase === 'running'} onClick={close}>
                {t('common:close')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
