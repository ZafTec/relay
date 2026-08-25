import type { ReactNode } from "react";

export type NoticeTone = "info" | "success" | "warning" | "error";

const glyphs: Record<NoticeTone, string> = {
  info: "□",
  success: "■",
  warning: "▲",
  error: "▲",
};

interface InlineNoticeProps {
  title: string;
  children: ReactNode;
  tone?: NoticeTone;
  action?: ReactNode;
}

export function InlineNotice({ title, children, tone = "info", action }: InlineNoticeProps) {
  return (
    <div
      className={`inline-notice inline-notice--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="inline-notice__glyph" aria-hidden="true">{glyphs[tone]}</span>
      <div className="inline-notice__body">
        <p className="inline-notice__title">{title}</p>
        <div className="inline-notice__copy">{children}</div>
        {action ? <div className="inline-notice__action">{action}</div> : null}
      </div>
    </div>
  );
}
