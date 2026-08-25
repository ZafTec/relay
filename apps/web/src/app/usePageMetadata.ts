import { useEffect } from "react";

export function usePageMetadata(title: string, themeColor: string): void {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousTheme = meta?.content;
    document.title = title;
    if (meta) meta.content = themeColor;

    return () => {
      document.title = previousTitle;
      if (meta && previousTheme) meta.content = previousTheme;
    };
  }, [themeColor, title]);
}
