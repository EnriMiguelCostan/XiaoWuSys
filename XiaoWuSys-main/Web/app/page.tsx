import { ConnectionPreview } from '@/components/connection/connection-preview';

// Batch M0 placeholder. Replaced by the login screen and app shell in M1.
export default function Home() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-16">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">XiaoMei ERP</h1>
        <p className="text-muted-foreground">
          The new screens are being built. Keep using the current system for daily work.
        </p>
      </div>
      <ConnectionPreview />
    </main>
  );
}
