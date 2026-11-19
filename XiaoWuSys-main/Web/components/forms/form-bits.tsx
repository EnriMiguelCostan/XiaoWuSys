// Small layout pieces shared by the dialogs and forms.
// HCI pass (docs/hci-design-audit.md):
//   - Gestalt proximity: a label, its control, its hint and its error sit 6px apart (gap-1.5);
//     forms put 16px (space-y-4 / gap-4) between separate fields.
//   - Required fields: a trailing " *" in the label is drawn for sighted users and read out as
//     "(required)"; RequiredNote explains the mark once per form.
//   - Errors are never colour alone: an alert icon, the words, and aria-invalid on the control.
import { cloneElement, isValidElement } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type DescribedProps = { 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' };

export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  /** What is wrong with this field and how to fix it (e.g. the server's message for it) */
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const required = label.endsWith(' *');
  const text = required ? label.slice(0, -2) : label;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // The single control inside learns its hint / error (screen readers read them with it)
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control =
    isValidElement<DescribedProps>(children) && (describedBy || error)
      ? cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
          ...(error ? { 'aria-invalid': true } : {}),
        })
      : children;
  return (
    <div className={cn('flex max-w-full min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="self-start">
        {text}
        {required && (
          <>
            <span aria-hidden className="text-danger">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        )}
      </Label>
      {control}
      {hint && (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={cn('flex items-start gap-1.5 text-xs leading-relaxed', TONE_CLASSES.danger.text)}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** Once per form that marks fields with "*" (Nielsen: recognition rather than recall). */
export function RequiredNote({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      Fields marked <span className="font-semibold text-danger">*</span> are required.
    </p>
  );
}

/** The server's plain-language reason, shown next to the form (steering §3.1). */
export function FormProblem({ message, tone = 'danger' }: { message: string; tone?: 'danger' | 'warning' }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn('flex gap-2 rounded-md border p-3 text-sm leading-relaxed whitespace-pre-line wrap-anywhere', TONE_CLASSES[tone].banner)}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

/**
 * The field the server named in a 400 VALIDATION_FAILED answer, and its plain-language message
 * (details[].field / message), so the form can show it next to that field. Display only: the
 * server decided it; nothing is parsed out of the text.
 */
export const fieldError = (data: unknown, field: string): string => {
  const details = (data as { details?: { field?: string; message?: string }[] } | null)?.details;
  if (!Array.isArray(details)) return '';
  return details.find((d) => d && d.field === field)?.message ?? '';
};

type Detail = { field?: string; message?: string };

/**
 * Every field the server named in a 400 VALIDATION_FAILED answer, as { field: message } (the
 * first message per field). Forms pass `fieldErrors.<name>` to <Field error>. Empty for any
 * other answer, so the form keeps its top banner (Nielsen H9: the error sits at its cause).
 */
export const fieldErrorsMap = (data: unknown): Record<string, string> => {
  const body = data as { error?: string; details?: Detail[] } | null;
  const out: Record<string, string> = {};
  if (!body || body.error !== 'VALIDATION_FAILED' || !Array.isArray(body.details)) return out;
  for (const d of body.details) {
    if (d && typeof d.field === 'string' && typeof d.message === 'string' && !(d.field in out)) out[d.field] = d.message;
  }
  return out;
};

/**
 * Text for the form's top banner. When every problem the server named is already shown next to
 * a field on this form, the banner only points to it; otherwise (general error, or a field this
 * form does not show) it keeps the server's own words.
 */
export const bannerText = (data: unknown, shownFields: readonly string[], fallback: string): string => {
  const fields = Object.keys(fieldErrorsMap(data));
  if (fields.length > 0 && fields.every((f) => shownFields.includes(f))) {
    return fields.length === 1 ? 'Check the field marked below.' : 'Check the fields marked below.';
  }
  return errorMessage(data, fallback);
};
