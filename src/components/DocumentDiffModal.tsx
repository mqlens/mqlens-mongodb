import React, { useMemo } from 'react';
import { X, GitCompareArrows } from 'lucide-react';
import { EJSON, ObjectId, Long, Decimal128, Int32, Double, Binary, Timestamp } from 'bson';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { diffDocuments, type DiffLine, type DiffStatus } from '../lib/docDiff';
import { useEscapeClose } from '../lib/useEscapeClose';

interface DocumentDiffModalProps {
  isOpen: boolean;
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  onClose: () => void;
}

// Parse raw (possibly Extended-JSON) docs into rich BSON instances, mirroring
// DataGrid's parsedDocs, so the diff engine compares real ObjectId/Date/Long.
function toBson(doc: Record<string, unknown>): Record<string, unknown> {
  try {
    return EJSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  } catch {
    return doc;
  }
}

const printableString = (value: string): string => JSON.stringify(value);

// Syntax-colored rendering of one scalar value (same palette as DataGrid's
// renderBsonValueNode).
function renderScalar(val: unknown): React.ReactNode {
  if (val === null || val === undefined) return <span className="text-syntax-null">null</span>;
  if (typeof val === 'boolean') return <span className="text-syntax-boolean font-bold">{val ? 'true' : 'false'}</span>;
  if (typeof val === 'number') return <span className="text-syntax-number">{String(val)}</span>;
  if (typeof val === 'string') return <span className="text-syntax-string">{printableString(val)}</span>;
  if (val instanceof ObjectId) return <><span className="text-syntax-boolean">ObjectId</span>(<span className="text-syntax-string">{printableString(val.toString())}</span>)</>;
  if (val instanceof Date) return <><span className="text-syntax-boolean">ISODate</span>(<span className="text-syntax-string">{printableString(val.toISOString())}</span>)</>;
  if (val instanceof Long) return <><span className="text-syntax-boolean">NumberLong</span>(<span className="text-syntax-number">{val.toString()}</span>)</>;
  if (val instanceof Decimal128) return <><span className="text-syntax-boolean">NumberDecimal</span>(<span className="text-syntax-string">{printableString(val.toString())}</span>)</>;
  if (val instanceof Int32) return <><span className="text-syntax-boolean">NumberInt</span>(<span className="text-syntax-number">{val.toString()}</span>)</>;
  if (val instanceof Double) return <><span className="text-syntax-boolean">Double</span>(<span className="text-syntax-number">{val.toString()}</span>)</>;
  if (val instanceof Binary) return <><span className="text-syntax-boolean">BinData</span>(<span className="text-syntax-number">{val.sub_type}</span>, <span className="text-syntax-string">{printableString(val.toString('base64'))}</span>)</>;
  if (val instanceof Timestamp) return <><span className="text-syntax-boolean">Timestamp</span>(<span className="text-syntax-number">{val.toString()}</span>)</>;
  return <span>{String(val)}</span>;
}

function renderLineContent(line: DiffLine): React.ReactNode {
  if (line.status === 'gap' || line.kind === 'gap') return null;
  const key = line.keyLabel ? (
    <>
      <span className="text-syntax-key">"{line.keyLabel}"</span>
      <span className="text-muted-foreground"> : </span>
    </>
  ) : null;
  if (line.kind === 'object' || line.kind === 'array') {
    return (
      <>
        {key}
        <span className="text-muted-foreground">{line.bracket}</span>
        {(line.bracket === '{' || line.bracket === '[') && line.childCount !== undefined ? (
          <span className="text-muted-foreground"> {line.childCount}</span>
        ) : null}
      </>
    );
  }
  return (
    <>
      {key}
      {renderScalar(line.value)}
    </>
  );
}

// Map a diff status to the repo's success/warning/destructive tint convention
// (see ConnectionCard.tsx / DocumentEditModal.tsx usage).
const lineTintClass = (status: DiffStatus): string => {
  switch (status) {
    case 'changed':
      return 'bg-warning/10';
    case 'added':
      return 'bg-success/10';
    case 'removed':
      return 'bg-destructive/10';
    case 'gap':
      return 'bg-muted/30';
    default:
      return '';
  }
};

const DiffColumn: React.FC<{ lines: DiffLine[]; testid: string }> = ({ lines, testid }) => (
  <div className="mql-diff-col overflow-auto rounded-md border border-border bg-background" data-testid={testid}>
    {lines.map((line, i) => (
      <div
        key={i}
        className={cn('mql-diff-line flex items-start whitespace-pre font-mono text-xs leading-6', `is-${line.status}`, lineTintClass(line.status))}
        data-status={line.status}
      >
        <span className="mql-diff-num w-9 shrink-0 select-none pr-2 text-right text-muted-foreground/70">
          {line.status === 'gap' ? '' : i + 1}
        </span>
        <span className="mql-diff-content min-w-0 flex-1" style={{ paddingLeft: line.depth * 16 }}>
          {renderLineContent(line)}
        </span>
      </div>
    ))}
  </div>
);

export const DocumentDiffModal: React.FC<DocumentDiffModalProps> = ({ isOpen, left, right, onClose }) => {
  const diff = useMemo(() => diffDocuments(toBson(left), toBson(right)), [left, right]);

  useEscapeClose(isOpen, onClose);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      {isOpen && (
        <DraggableDialogContent
          resetKey={isOpen}
          defaultWidth={1000}
          defaultHeight={640}
          minWidth={640}
          minHeight={360}
          hideClose
          className="flex min-h-0 flex-col gap-0 p-0"
          data-testid="document-diff-modal"
        >
          <DialogHeader
            data-dialog-drag-handle
            className="flex cursor-grab flex-row items-center justify-between border-b border-border px-4 py-3 active:cursor-grabbing"
          >
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <GitCompareArrows size={14} className="text-primary" />
                Compare Documents
              </DialogTitle>
              <span className="flex items-center gap-1.5" data-testid="diff-summary">
                <Badge variant="warning">{diff.changedCount} changed</Badge>
                <Badge variant="success">{diff.addedCount} added</Badge>
                <Badge variant="destructive">{diff.removedCount} removed</Badge>
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close modal"
            >
              <X size={13} />
            </Button>
          </DialogHeader>

          <div className="mql-diff-grid grid min-h-0 flex-1 grid-cols-2 gap-3 p-4">
            <div className="flex min-h-0 flex-col gap-1">
              <div className="mql-diff-colhead text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Document A
              </div>
              <DiffColumn lines={diff.left} testid="diff-left" />
            </div>
            <div className="flex min-h-0 flex-col gap-1">
              <div className="mql-diff-colhead text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Document B
              </div>
              <DiffColumn lines={diff.right} testid="diff-right" />
            </div>
          </div>
        </DraggableDialogContent>
      )}
    </Dialog>
  );
};
