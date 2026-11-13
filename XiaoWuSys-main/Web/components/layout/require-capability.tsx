'use client';

// Shows its children only to accounts the server gave `capability`. Cosmetic: a typed URL
// still reaches the page, and Express answers 403 to every request it makes.
import { ShieldX } from 'lucide-react';
import { can, type Capability } from '@xiaowu/client-core/permissions';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/hooks/use-session';

export function RequireCapability({ capability, children }: { capability: Capability; children: React.ReactNode }) {
  const { user } = useSession();
  if (can(user, capability)) return <>{children}</>;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldX className="size-5 text-muted-foreground" aria-hidden />
          Not available for your account
        </CardTitle>
        <CardDescription>Your account does not have permission to open this page. Please ask an Owner or Admin.</CardDescription>
      </CardHeader>
    </Card>
  );
}
