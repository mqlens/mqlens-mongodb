import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  answerWriteRequest,
  subscribeWriteRequests,
  writeRequestsWhere,
} from '../lib/mcpWriteRequests';
import type { McpWriteRequest } from '../workspace/workspaceStore';

/**
 * The prompt for a write no conversation asked for.
 *
 * Every MCP route confirms its writes in the app, not just MQLens's own agent:
 * `_confirm` is a boolean the calling agent supplies, so it was never a gate,
 * and an external client reaching these tools through its own config would
 * otherwise write with nobody asked. The backend addresses a request to a
 * conversation only when it can attribute it to one; an external client's
 * write is addressed to nobody.
 *
 * Those unaddressed requests used to be rendered only inside `AIChatPanel`,
 * which renders nothing while closed and is unmounted entirely on a tab switch.
 * So a write from an external client while the user was in Settings — or simply
 * not in a chat — had no visible prompt at all and could only time out, after
 * the user had already approved it in the client they were working in (#352
 * review). It is the app being asked, not a conversation, so the app asks.
 *
 * Requests that *are* addressed to a conversation stay with that conversation's
 * panel, where the user can see what led to them.
 */
export function McpWriteConfirm() {
  const { t } = useTranslation('shell');
  const [requests, setRequests] = useState<McpWriteRequest[]>([]);

  useEffect(() => {
    const refresh = () =>
      // Unaddressed only. A request belonging to a conversation is answered in
      // that conversation's panel, so claiming it here would put one chat's
      // operation in front of whoever happened to be looking.
      setRequests(writeRequestsWhere((requester) => requester === null));
    refresh();
    return subscribeWriteRequests(refresh);
  }, []);

  // Oldest first, one at a time: each answer removes it and the next takes its
  // place, so a burst is worked through rather than stacked.
  const request = requests[0];
  if (!request) return null;

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[560px] [&>button.absolute]:hidden"
        data-testid="mcp-write-confirm"
        // Neither dismissal is an answer, and silence is a refusal the caller
        // waits two minutes for. Make the user choose.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldAlert size={16} className="text-destructive" />
            {t('mcpWriteConfirm.title')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('mcpWriteConfirm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="font-mono text-[11px] font-semibold text-foreground" data-testid="mcp-write-confirm-tool">
            {request.tool}
          </div>
          {/* The operation itself, not a summary: the backend deliberately sends
              what will run, because a filter reported as a byte count is useless
              for deciding. */}
          <pre
            className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-foreground"
            data-testid="mcp-write-confirm-summary"
          >
            {request.summary}
          </pre>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            data-testid="mcp-write-confirm-refuse"
            onClick={() => answerWriteRequest(request.id, false)}
          >
            {t('mcpWriteConfirm.refuse')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-[11px]"
            data-testid="mcp-write-confirm-allow"
            onClick={() => answerWriteRequest(request.id, true)}
          >
            {t('mcpWriteConfirm.allow')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
