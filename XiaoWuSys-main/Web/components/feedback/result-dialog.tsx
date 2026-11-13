'use client';

// Every finished action ends in a ResultDialog (carried over from Dialogs.jsx): no silent toasts.
// result = { type: 'success' | 'warning' | 'error', title, message } or null when closed.
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RESULT, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export interface ResultMessage {
  type: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export function ResultDialog({ result, onClose }: { result: ResultMessage | null; onClose: () => void }) {
  const look = RESULT[result?.type ?? 'success'];
  const Icon = look.icon;

  return (
    <Dialog open={Boolean(result)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('size-5 shrink-0', TONE_CLASSES[look.tone].text)} aria-hidden />
            {result?.title}
          </DialogTitle>
          {/* Server and client-core messages use \n for line breaks */}
          <DialogDescription className="whitespace-pre-line">{result?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose} autoFocus>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
