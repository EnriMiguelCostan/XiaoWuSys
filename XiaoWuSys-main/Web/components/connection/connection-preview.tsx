'use client';

// Batch M0 smoke check: proves Web/ builds against @xiaowu/client-core, resolves the shop server
// address at run time and renders a server state through lib/ui-tokens.ts. It only reads
// GET /api/status (no login). Removed in M1 when the real ConnectionBar arrives.
import { useEffect, useState } from 'react';
import {
  connectionText,
  deriveConnectionState,
  type CloudState,
  type ConnectionState,
} from '@xiaowu/client-core/connection';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiBase } from '@/lib/config';
import { CONNECTION, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export function ConnectionPreview() {
  const [state, setState] = useState<ConnectionState>('checking');
  const [server, setServer] = useState('');

  useEffect(() => {
    // Resolved here, in the browser, from the address this page was opened on (Q4 tablets).
    const base = apiBase();
    let cancelled = false;
    fetch(`${base}/status`)
      .then((res) => res.json())
      .then((body: { cloud?: CloudState }) => {
        if (cancelled) return;
        setServer(base);
        setState(deriveConnectionState({ serverReachable: true, cloud: body.cloud }));
      })
      .catch(() => {
        if (cancelled) return;
        setServer(base);
        setState(deriveConnectionState({ serverReachable: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { label, detail } = connectionText(state);
  const look = CONNECTION[state];
  const Icon = look.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection</CardTitle>
        <CardDescription>{server ? `Shop server: ${server}` : 'Finding the shop server…'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2" aria-live="polite">
        <Badge variant="outline" className={cn('gap-1.5', TONE_CLASSES[look.tone].badge)}>
          <Icon className="size-3.5" aria-hidden />
          {label}
        </Badge>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
