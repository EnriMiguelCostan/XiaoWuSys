'use client';

// PB 3 / PB 4: the always-visible connection bar. Says whether work goes to the cloud or stays
// on this computer, how many changes are waiting, and offers "Sync now".
// Labels: connectionText() / pendingText() / syncDisabledReason() in client-core.
// Colours and icons: lib/ui-tokens.ts. Nothing here decides anything.
import { RefreshCw } from 'lucide-react';
import { connectionText, pendingText, syncDisabledReason } from '@xiaowu/client-core/connection';
import { formatDateTime } from '@xiaowu/client-core/format';
import { can } from '@xiaowu/client-core/permissions';
import { useConnection } from '@/components/connection/connection-provider';
import { ResultDialog } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSession } from '@/hooks/use-session';
import { CONNECTION, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export function ConnectionBar() {
  const { user } = useSession();
  const { state, syncStatus, browserOnline, syncBusy, syncNow, syncResult, dismissSyncResult } = useConnection();

  const { label, detail } = connectionText(state, { cloud: syncStatus?.cloud, browserOnline });
  const look = CONNECTION[state];
  const Icon = look.icon;
  const blocked = syncDisabledReason({ state, syncing: syncBusy });
  const pendingTotal = syncStatus?.pending_total ?? 0;
  // Conflicts are only shown to accounts that can resolve them
  const conflictCount = can(user, 'manage_accounts') ? (syncStatus?.conflicts ?? 0) : 0;
  const lastSynced =
    state === 'online' && syncStatus?.last_sync_at ? ` Last synced ${formatDateTime(syncStatus.last_sync_at)}.` : '';

  const syncButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => void syncNow()}
      disabled={Boolean(blocked)}
      aria-label={syncBusy ? 'Sync is running' : 'Sync now: send the changes saved on this computer to the cloud'}
    >
      <RefreshCw className={cn(syncBusy && 'animate-spin')} aria-hidden />
      {syncBusy ? 'Syncing…' : 'Sync now'}
    </Button>
  );

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className={cn('border-b px-4 py-2 text-sm', TONE_CLASSES[look.tone].banner)}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Icon className={cn('mt-0.5 size-4 shrink-0', state === 'checking' && 'animate-spin')} aria-hidden />
            <p className="min-w-0">
              <strong className="font-semibold">{label}</strong>
              <span className="ml-2 hidden text-foreground/70 sm:inline">
                {detail}
                {lastSynced}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn('bg-background/60', pendingTotal > 0 ? TONE_CLASSES.warning.badge : TONE_CLASSES.muted.badge)}
            >
              {pendingText(pendingTotal)}
            </Badge>
            {conflictCount > 0 && (
              <Badge variant="outline" className={TONE_CLASSES.danger.badge}>
                {conflictCount} need{conflictCount === 1 ? 's' : ''} a decision
              </Badge>
            )}
            {/* A disabled button gets no pointer events, so the tooltip hangs on a wrapper */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={blocked ? 0 : -1} className="inline-flex">
                  {syncButton}
                </span>
              </TooltipTrigger>
              <TooltipContent>{blocked || 'Send the changes saved on this computer to the cloud now'}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <ResultDialog result={syncResult} onClose={dismissSyncResult} />
    </>
  );
}
