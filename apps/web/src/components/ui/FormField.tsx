import type { InputHTMLAttributes, ReactNode } from "react";

interface FormFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  trailing?: ReactNode;
}

export function FormField({
  id,
  label,
  hint,
  error,
  trailing,
  className,
  ...inputProps
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={id}>{label}</label>
      {hint ? <p className="form-field__hint" id={hintId}>{hint}</p> : null}
      <div className="form-field__control">
        <input
          {...inputProps}
          id={id}
          className={["input", className].filter(Boolean).join(" ")}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        />
        {trailing}
      </div>
      {error ? <p className="form-field__error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

interface RadioCardProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  title: string;
  metadata?: string;
}

export function RadioCard({ id, title, metadata, ...props }: RadioCardProps) {
  return (
    <label className="radio-card" htmlFor={id}>
      <input {...props} id={id} className="radio-card__input" type="radio" />
      <span className="radio-card__indicator" aria-hidden="true" />
      <span className="radio-card__copy">
        <span className="radio-card__title">{title}</span>
        {metadata ? <span className="radio-card__metadata">{metadata}</span> : null}
      </span>
    </label>
  );
}
