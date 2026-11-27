export interface ExtractChangelogOptions {
  repo?: string;
  ref?: string;
}

export function normalizeVersion(raw: string | null | undefined): string;

export function rewriteRelativeLinks(
  markdown: string,
  options?: ExtractChangelogOptions,
): string;

export function extractChangelogSection(
  markdown: string,
  rawTagOrVersion: string | null | undefined,
  options?: ExtractChangelogOptions,
): string | null;
