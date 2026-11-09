import { useEffect, useState } from "react";

/** The viewport width at or below which views switch to their phone layout. */
export const NARROW_QUERY = "(max-width: 760px)";

/** True while the viewport matches `query` (the phone layout by default); follows resizes. */
export function useNarrow(query: string = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}
