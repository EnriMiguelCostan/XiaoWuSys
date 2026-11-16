'use client';

// Every finished action ends here: result = { type: 'success' | 'warning' | 'error', title, message }
// or null when there is nothing to show.
//   - success         -> a small pop-up notice (lib/toast.ts) that closes by itself: the action
//                        went through and the person keeps working without an extra click
//   - warning / error -> this dialog, which stays until OK: the person has to know or do something
//                        (a refusal, a stock warning, an overpayment...)
// Screens keep calling setResult(...) exactly as before; this component picks the right form.
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/toast';
import { RESULT, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export interface ResultMessage {
  type: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export function ResultDialog({ result, onClose }: { result: ResultMessage | null; onClose: () => void }) {
  // A success becomes a notice once (the ref also stops React's dev double-run showing it twice)
  const announced = useRef<ResultMessage | null>(null);
  useEffect(() => {
    if (!result || result.type !== 'success' || announced.current === result) return;
    announced.current = result;
    toast.success(result.title, result.message);
    onClose();
  }, [result, onClose]);

  const shown = result && result.type !== 'success' ? result : null;
  const look = RESULT[shown?.type ?? 'error'];
  const Icon = look.icon;

  return (
    <Dialog open={Boolean(shown)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" dismissible>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('size-5 shrink-0', TONE_CLASSES[look.tone].text)} aria-hidden />
            {shown?.title}
          </DialogTitle>
          {/* Server and client-core messages use \n for line breaks */}
          <DialogDescription className="whitespace-pre-line wrap-anywhere">{shown?.message}</DialogDescription>
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
