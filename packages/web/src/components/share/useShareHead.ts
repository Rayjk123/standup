import { useEffect } from "react";

/**
 * Keeps a share page's token out of every request it makes and out of search
 * indexes: no referrer to the media it loads or a site it links to, no robots.
 */
export function useShareHead(): void {
  useEffect(() => {
    const added = [
      ["referrer", "no-referrer"],
      ["robots", "noindex, nofollow"],
    ].map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name!;
      meta.content = content!;
      document.head.appendChild(meta);
      return meta;
    });
    return () => added.forEach((m) => m.remove());
  }, []);
}
