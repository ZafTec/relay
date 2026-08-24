import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

export type ButtonVariant = "accent" | "ink" | "outline" | "quiet";

function classes(variant: ButtonVariant, className?: string): string {
  return ["button", `button--${variant}`, className].filter(Boolean).join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  pending?: boolean;
  pendingLabel?: string;
  endGlyph?: ReactNode;
}

export function Button({
  variant = "accent",
  pending = false,
  pendingLabel,
  endGlyph,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classes(variant, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      <span className="button__label">{pending && pendingLabel ? pendingLabel : children}</span>
      {endGlyph ? <span className="button__glyph" aria-hidden="true">{endGlyph}</span> : null}
    </button>
  );
}

interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  endGlyph?: ReactNode;
}

export function LinkButton({
  variant = "accent",
  endGlyph,
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <Link {...props} className={classes(variant, className)}>
      <span className="button__label">{children}</span>
      {endGlyph ? <span className="button__glyph" aria-hidden="true">{endGlyph}</span> : null}
    </Link>
  );
}
