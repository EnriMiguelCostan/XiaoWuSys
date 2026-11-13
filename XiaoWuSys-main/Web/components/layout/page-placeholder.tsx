// Empty section page for Batch M1. Each one is replaced when its screen is ported (M2–M4).
import { Construction } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function PagePlaceholder({ title, batch }: { title: string; batch: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Construction className="size-5 text-muted-foreground" aria-hidden />
            Coming soon
          </CardTitle>
          <CardDescription>
            This screen is being moved to the new system ({batch}). Keep using the current system for this work.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
