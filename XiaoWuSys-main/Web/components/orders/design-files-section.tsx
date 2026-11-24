'use client';

// Migration 016 (adviser consultation): design files picked from this computer, so a design no
// longer has to be put on Google Drive first. The files are kept in the cloud (every branch sees
// them), so attaching, opening and removing need the internet connection.
//   GET    /api/orders/:id/design-files (also sent with the order as detail.design_files)
//   POST   /api/orders/:id/design-files?name=&notes=   the file itself as the body
//   GET    /api/orders/:id/design-files/:file_id        download (?inline=1: image preview)
//   DELETE /api/orders/:id/design-files/:file_id
// The server decides which files may be attached and which can be shown as a picture; the
// buttons come from allowed_actions.manage_design_files.
import { useEffect, useRef, useState } from 'react';
import { Download, FileImage, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/hooks/use-api';
import { errorMessage, fetchBlob, saveBlob, uploadFile } from '@/lib/api';
import type { DesignFile, OrderDetail } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

/** What the file picker offers (the server checks the real list) */
export const DESIGN_FILE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.tif,.tiff,.bmp,.pdf,.ai,.eps,.psd,.cdr,.zip,.doc,.docx,.txt';
export const DESIGN_FILE_MAX_MB = 20;

export const fileSize = (bytes: number) =>
  // rules-guard: allow no-rule-math file size shown in KB or MB only
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/** Sends files one by one to an order -> the messages, in order (used here and by Create order) */
export async function uploadDesignFiles(orderId: string, files: File[], notes = ''): Promise<{ ok: boolean; message: string }[]> {
  const out: { ok: boolean; message: string }[] = [];
  for (const file of files) {
    const { ok, data } = await uploadFile<{ message?: string }>(
      `/orders/${encodeURIComponent(orderId)}/design-files`,
      file,
      notes.trim() ? { notes: notes.trim() } : {}
    );
    out.push({ ok, message: ok ? (data.message ?? `${file.name} attached.`) : `${file.name}: ${errorMessage(data, 'it was not attached.')}` });
  }
  return out;
}

export function DesignFilesSection({
  detail,
  actions,
  onResult,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: (result: ResultMessage, reload: boolean) => void;
}) {
  const api = useApi();
  const files = detail.design_files ?? [];
  const available = detail.design_files_available !== false;
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<DesignFile | null>(null);
  const orderId = detail.order.order_id;
  const tooBig = picked.filter((f) => f.size > DESIGN_FILE_MAX_MB * 1024 * 1024);

  const upload = async () => {
    if (picked.length === 0 || tooBig.length > 0) return;
    setBusy(true);
    const results = await uploadDesignFiles(orderId, picked, notes);
    setBusy(false);
    setPicked([]);
    setNotes('');
    if (inputRef.current) inputRef.current.value = '';
    const failed = results.filter((r) => !r.ok);
    onResult(
      {
        type: failed.length === 0 ? 'success' : failed.length === results.length ? 'error' : 'warning',
        title: failed.length === 0 ? 'Design files attached' : 'Some files were not attached',
        message: results.map((r) => r.message).join('\n'),
      },
      true
    );
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(
      'DELETE',
      `/orders/${encodeURIComponent(orderId)}/design-files/${encodeURIComponent(removing.file_id)}`
    );
    setBusy(false);
    setRemoving(null);
    onResult(
      ok
        ? { type: 'success', title: 'Design file removed', message: data.message ?? 'Removed.' }
        : { type: 'error', title: 'Not removed', message: errorMessage(data, 'The file was not removed.') },
      true
    );
  };

  const download = async (f: DesignFile) => {
    const got = await fetchBlob(`/orders/${encodeURIComponent(orderId)}/design-files/${encodeURIComponent(f.file_id)}`);
    if (got.ok) saveBlob(got.blob, f.file_name);
    else onResult({ type: 'error', title: 'Could not open the file', message: got.message }, false);
  };

  if (!available && files.length === 0 && !actions.manage_design_files) return null;

  return (
    <section className="space-y-2 rounded-md border bg-card p-3" aria-labelledby="design-files-title">
      <h3 id="design-files-title" className="flex items-center gap-2 font-semibold">
        <Paperclip className="size-4 text-muted-foreground" aria-hidden /> Design files from the computer
      </h3>
      {!available && (
        <p className={cn('rounded-md border p-2 text-sm', TONE_CLASSES.info.banner)}>
          The design files are kept in the cloud. They will show here when the internet connection is back.
        </p>
      )}
      {available && files.length === 0 && <p className="text-sm text-muted-foreground">No design files attached yet.</p>}
      {files.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((f) => (
            <li key={f.file_id} className="flex min-w-0 gap-3 rounded-md border p-2">
              <DesignThumb orderId={orderId} file={f} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium" title={f.file_name}>
                  {f.file_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {fileSize(f.size_bytes)} · {formatDateTime(f.uploaded_at, { utc: true })}
                  {f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ''}
                </p>
                {f.notes && <p className="text-xs wrap-anywhere">{f.notes}</p>}
                <div className="flex flex-wrap gap-1 pt-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => void download(f)}>
                    <Download aria-hidden /> Download
                  </Button>
                  {actions.manage_design_files && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(f)} aria-label={`Remove ${f.file_name}`}>
                      <Trash2 aria-hidden /> Remove
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {actions.manage_design_files && available && (
        <div className="space-y-2 rounded-md border border-dashed p-2">
          <label htmlFor="design-file-input" className="text-sm font-medium">
            Attach files from this computer
          </label>
          <Input
            ref={inputRef}
            id="design-file-input"
            type="file"
            multiple
            accept={DESIGN_FILE_ACCEPT}
            onChange={(e) => setPicked(Array.from(e.target.files ?? []))}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            Pictures, PDF, AI, PSD, CDR, EPS, ZIP… up to {DESIGN_FILE_MAX_MB} MB each. No need to upload to Google Drive first.
          </p>
          {picked.length > 0 && (
            <>
              <Input maxLength={500} placeholder="Note for these files (optional), e.g. final front design" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
              {tooBig.length > 0 && (
                <p role="alert" className={cn('rounded-md border p-2 text-sm', TONE_CLASSES.danger.banner)}>
                  Too large (over {DESIGN_FILE_MAX_MB} MB): {tooBig.map((f) => f.name).join(', ')}. Choose smaller files.
                </p>
              )}
              <Button type="button" size="sm" onClick={() => void upload()} busy={busy} disabled={busy || tooBig.length > 0}>
                <Upload aria-hidden /> {busy ? 'Uploading…' : `Attach ${picked.length} file${picked.length === 1 ? '' : 's'}`}
              </Button>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this design file?"
        message={removing ? `${removing.file_name} will be removed from the order. A record of the removal is kept.` : ''}
        confirmLabel="Remove file"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}

/** A small preview for real images; an icon for everything else */
function DesignThumb({ orderId, file }: { orderId: string; file: DesignFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.previewable) return undefined;
    let made: string | null = null;
    let cancelled = false;
    fetchBlob(`/orders/${encodeURIComponent(orderId)}/design-files/${encodeURIComponent(file.file_id)}?inline=1`).then((got) => {
      if (cancelled || !got.ok) return;
      made = URL.createObjectURL(got.blob);
      setUrl(made);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [orderId, file.file_id, file.previewable]);
  const Icon = file.mime_type.startsWith('image/') ? FileImage : FileText;
  return (
    <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40">
      {url ? (
        // A blob: URL made from the server's checked image (next/image cannot load it)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`Preview of ${file.file_name}`} className="size-full object-cover" />
      ) : (
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      )}
    </div>
  );
}
