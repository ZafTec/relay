import type { ChangelogCategory } from "../../lib/api/changelog";

export const CHANGELOG_CATEGORY_LABELS: Record<ChangelogCategory, string> = {
  added: "Added",
  improved: "Improved",
  fixed: "Fixed",
  security: "Security",
  breaking: "Breaking",
};

export function changelogDateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : value;
}
