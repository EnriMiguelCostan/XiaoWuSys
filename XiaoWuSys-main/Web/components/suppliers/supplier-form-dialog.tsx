'use client';

// Add or edit a supplier profile (POST / PATCH /api/suppliers). The server checks every field
// (phone, email, a name already saved) and answers in plain words; this form shows them.
import { useState } from 'react';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import type { Supplier } from '@/lib/stock';

const EMPTY = { supplier_name: '', contact_person: '', contact_number: '', email: '', address: '', notes: '' };
type Form = typeof EMPTY;

export function SupplierFormDialog({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: (supplier: Supplier | null, message: string) => void;
}) {
  const api = useApi();
  const [form, setForm] = useState<Form>(() =>
    supplier
      ? {
          supplier_name: supplier.supplier_name,
          contact_person: supplier.contact_person ?? '',
          contact_number: supplier.contact_number ?? '',
          email: supplier.email ?? '',
          address: supplier.address ?? '',
          notes: supplier.notes ?? '',
        }
      : EMPTY
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    // Empty text clears an optional field when editing; when adding it is simply left out
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? (supplier ? null : undefined) : v.trim()])
    );
    setBusy(true);
    const { ok, data } = supplier
      ? await api<{ supplier?: Supplier; message?: string }>('PATCH', `/suppliers/${encodeURIComponent(supplier.supplier_id)}`, body)
      : await api<{ supplier?: Supplier; message?: string }>('POST', '/suppliers', body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(EMPTY), 'The supplier was not saved.'));
      return;
    }
    onSaved(data.supplier ?? null, data.message ?? 'Supplier saved.');
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{supplier ? `Edit ${supplier.supplier_name}` : 'Add a supplier'}</DialogTitle>
          <DialogDescription>Who the shop buys from, and how to reach them.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <Field id="sup-name" label="Supplier name *" error={errors.supplier_name}>
            <Input id="sup-name" required maxLength={255} value={form.supplier_name} onChange={set('supplier_name')} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sup-person" label="Contact person" error={errors.contact_person}>
              <Input id="sup-person" maxLength={255} value={form.contact_person} onChange={set('contact_person')} />
            </Field>
            <Field id="sup-phone" label="Phone" error={errors.contact_number} hint="Mobile or landline">
              <Input id="sup-phone" type="tel" maxLength={20} value={form.contact_number} onChange={set('contact_number')} placeholder="09171234567" />
            </Field>
          </div>
          <Field id="sup-email" label="Email" error={errors.email}>
            <Input id="sup-email" type="email" maxLength={255} value={form.email} onChange={set('email')} placeholder="sales@supplier.ph" />
          </Field>
          <Field id="sup-address" label="Address" error={errors.address}>
            <Textarea id="sup-address" rows={2} maxLength={1000} value={form.address} onChange={set('address')} />
          </Field>
          <Field id="sup-notes" label="Notes" error={errors.notes} hint="e.g. delivery days, payment terms">
            <Textarea id="sup-notes" rows={2} maxLength={1000} value={form.notes} onChange={set('notes')} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : 'Save supplier'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
