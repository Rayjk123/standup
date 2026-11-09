// Runs community detection + ForceAtlas2 off the main thread: posted a
// GraphData, answers with its LayoutResult.

import { layoutGraph } from "./knowledgeGraphLayout";
import type { GraphData } from "./knowledgeGraph";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<GraphData>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = (e) => {
  ctx.postMessage(layoutGraph(e.data));
};
