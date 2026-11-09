// The WebGL knowledge-graph canvas: a Sigma.js renderer over a graphology
// graph of the full corpus, laid out once (positions are an input). Filtering,
// focus and dimming never touch the graph or the layout — they flow through
// sigma's node/edge reducers, which read the latest props from a ref, so a
// filter or hover change is a cheap refresh rather than a rebuild and the map
// never jumps. Loaded lazily, so sigma stays out of the main bundle.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import Sigma from "sigma";
import type { Settings } from "sigma/settings";
import type { NodeDisplayData, PartialButFor } from "sigma/types";
import { buildGraphology, type Positions } from "./knowledgeGraphLayout";
import { pairKey, RELATION_RANK, type GraphData, type GraphEdge, type GraphNode } from "./knowledgeGraph";
import { hexAlpha, palettes, theme, type Palette, type ThemeName } from "./theme";
import { useThemeName } from "../hooks/useTheme";

export interface GraphCanvasProps {
  // The full corpus and its layout; the sigma graph is rebuilt only when these change.
  graph: GraphData;
  positions: Positions;
  // The subgraph the filters leave visible.
  visible: GraphData;
  nodeColor: (node: GraphNode) => string;
  nodeSize: (id: string) => number;
  edgeColor: (kind: GraphEdge["kind"]) => string;
  // Docs drawn faded (distrusted by retrieval).
  deemphasized: ReadonlySet<string>;
  // The highlighted set; everything else is dimmed. Null highlights everything.
  focus: ReadonlySet<string> | null;
  selected: string | null;
  // Nodes whose label is drawn whatever the label grid decides.
  forcedLabels: ReadonlySet<string>;
  // Pixels at the canvas's left edge covered by an overlay; framing centers in
  // the rest.
  insetLeft?: number;
  // Positions (in layout coordinates) that replace the layout's for a view
  // with its own arrangement, such as a neighborhood; the layout is untouched.
  positionOverrides?: ReadonlyMap<string, { x: number; y: number }> | null;
  onHoverNode: (id: string | null, pos?: { x: number; y: number }) => void;
  onHoverEdge: (edge: { kind: GraphEdge["kind"]; evidence?: string } | null, pos?: { x: number; y: number }) => void;
  onClickNode: (id: string) => void;
  onClickEdge: (edge: { kind: GraphEdge["kind"]; source: string; target: string }) => void;
  onClickStage: () => void;
}

export interface GraphCanvasHandle {
  // Animate the camera to frame these nodes (one node: center on it, zoomed in).
  frameNodes: (ids: string[]) => void;
  fitAll: () => void;
  zoom: (factor: number) => void;
}

// `hex` blended toward `toward` by t (0 = hex, 1 = toward). Dimming blends
// toward the background rather than lowering alpha, so dimmed items stay opaque
// and overlap cleanly.
export function mixColor(hex: string, toward: string, t: number): string {
  const parse = (h: string) => {
    const v = h.replace("#", "").slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };
  const a = parse(hex);
  const b = parse(toward);
  return `#${a
    .map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, "0"))
    .join("")}`;
}

type DrawData = PartialButFor<NodeDisplayData, "x" | "y" | "size" | "label" | "color">;

// The canvas draws with literal colors (it can't resolve CSS variables), so it
// takes the literal palette plus the two graph inks: the plain label color and
// the gray a distrusted doc is faded toward.
export interface CanvasColors {
  palette: Palette;
  label: string;
  muted: string;
}

export function canvasColors(name: ThemeName): CanvasColors {
  const palette = palettes[name];
  return { palette, label: palette.graphLabel, muted: palette.graphMuted };
}

// Hover/selection drawing: a ring in the text color and the label on a
// surface plate. Sigma's default draws a white box, which glares on the dark
// ground.
function drawHover(
  context: CanvasRenderingContext2D,
  data: DrawData,
  settings: Settings,
  palette: Palette
): void {
  const size = settings.labelSize;
  context.font = `600 ${size}px ${settings.labelFont}`;
  context.beginPath();
  context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  context.strokeStyle = palette.text;
  context.lineWidth = 2;
  context.stroke();
  if (!data.label) return;
  const text = data.label.length > 60 ? `${data.label.slice(0, 59)}…` : data.label;
  const w = context.measureText(text).width;
  const x = data.x + data.size + 7;
  const y = data.y - size / 2 - 5;
  context.fillStyle = hexAlpha(palette.surface, 0xf2);
  context.strokeStyle = palette.edge;
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x, y, w + 12, size + 10, 4);
  context.fill();
  context.stroke();
  context.fillStyle = palette.text;
  context.textBaseline = "middle";
  context.fillText(text, x + 6, data.y);
}

// Plain labels on a translucent plate, so they stay legible over edges.
function drawLabel(
  context: CanvasRenderingContext2D,
  data: DrawData,
  settings: Settings,
  colors: CanvasColors
): void {
  if (!data.label) return;
  const size = settings.labelSize;
  context.font = `500 ${size}px ${settings.labelFont}`;
  const text = data.label.length > 40 ? `${data.label.slice(0, 39)}…` : data.label;
  const w = context.measureText(text).width;
  const x = data.x + data.size + 4;
  context.fillStyle = hexAlpha(colors.palette.ground, 0xb0);
  context.fillRect(x - 2, data.y - size / 2 - 2, w + 4, size + 4);
  context.fillStyle = colors.label;
  context.textBaseline = "middle";
  context.fillText(text, x, data.y);
}

interface Derived {
  props: GraphCanvasProps;
  colors: CanvasColors;
  visibleIds: Set<string>;
  // Visible pair → the strongest visible kind and its edge.
  visiblePairs: Map<string, GraphEdge>;
}

const KnowledgeGraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function KnowledgeGraphCanvas(
  props,
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  const themeName = useThemeName();
  const colors = useMemo(() => canvasColors(themeName), [themeName]);
  const derivedNow = useMemo<Omit<Derived, "props" | "colors">>(() => {
    const visibleIds = new Set(props.visible.nodes.map((n) => n.id));
    const visiblePairs = new Map<string, GraphEdge>();
    for (const e of props.visible.edges) {
      const key = pairKey(e.source, e.target);
      const cur = visiblePairs.get(key);
      if (!cur || RELATION_RANK[e.kind] > RELATION_RANK[cur.kind]) visiblePairs.set(key, e);
    }
    return { visibleIds, visiblePairs };
  }, [props.visible]);

  const latest = useRef<Derived>({ props, colors, ...derivedNow });
  latest.current = { props, colors, ...derivedNow };

  const nodeById = useMemo(() => new Map(props.graph.nodes.map((n) => [n.id, n])), [props.graph]);
  const nodeByIdRef = useRef(nodeById);
  nodeByIdRef.current = nodeById;

  // Build the renderer once per corpus + layout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const g = buildGraphology(props.graph);
    for (const n of props.graph.nodes) {
      const p = props.positions[n.id] ?? { x: 0, y: 0 };
      g.mergeNodeAttributes(n.id, { x: p.x, y: p.y, label: n.title, size: 4, color: latest.current.colors.palette.dim });
    }
    // Every color is read from `latest` at draw time, so a theme switch is a
    // refresh like any other prop change.
    const drawThemedHover = (context: CanvasRenderingContext2D, data: DrawData, settings: Settings) =>
      drawHover(context, data, settings, latest.current.colors.palette);
    const drawThemedLabel = (context: CanvasRenderingContext2D, data: DrawData, settings: Settings) =>
      drawLabel(context, data, settings, latest.current.colors);
    const sigma = new Sigma(g, container, {
      renderEdgeLabels: false,
      enableEdgeEvents: true,
      zIndex: true,
      labelFont: theme.sans,
      labelSize: 12,
      labelColor: { color: latest.current.colors.label },
      labelDensity: 0.55,
      labelGridCellSize: 110,
      labelRenderedSizeThreshold: 9,
      defaultDrawNodeHover: drawThemedHover,
      defaultDrawNodeLabel: drawThemedLabel,
      minCameraRatio: 0.04,
      maxCameraRatio: 3,
      stagePadding: 40,
      nodeReducer: (id, attrs) => {
        const { props: p, visibleIds, colors: c } = latest.current;
        if (!visibleIds.has(id)) return { ...attrs, hidden: true };
        const bg = c.palette.ground;
        const node = nodeByIdRef.current.get(id);
        let color = node ? p.nodeColor(node) : c.palette.dim;
        if (p.deemphasized.has(id)) color = mixColor(color, c.muted, 0.75);
        const inFocus = !p.focus || p.focus.has(id);
        if (!inFocus) color = mixColor(color, bg, 0.82);
        return {
          ...attrs,
          color,
          size: p.nodeSize(id),
          label: inFocus ? (attrs.label as string) : null,
          forceLabel: inFocus && p.forcedLabels.has(id),
          highlighted: id === p.selected,
          zIndex: id === p.selected ? 3 : inFocus && p.focus ? 2 : inFocus ? 1 : 0,
        };
      },
      edgeReducer: (key, attrs) => {
        const { props: p, visiblePairs, colors: c } = latest.current;
        const edge = visiblePairs.get(key);
        if (!edge) return { ...attrs, hidden: true };
        const bg = c.palette.ground;
        const base = p.edgeColor(edge.kind);
        const active = p.focus !== null && p.focus.has(edge.source) && p.focus.has(edge.target);
        const thickness = 0.6 + Math.min(1, edge.weight) * 1.2;
        if (p.focus === null) {
          return { ...attrs, color: mixColor(base, bg, edge.kind === "contradicts" ? 0.2 : 0.62), size: thickness, zIndex: edge.kind === "contradicts" ? 1 : 0 };
        }
        return active
          ? { ...attrs, color: base, size: thickness + 0.8, zIndex: 2 }
          : { ...attrs, color: mixColor(base, bg, 0.93), size: 0.5, zIndex: 0 };
      },
    });
    sigmaRef.current = sigma;

    sigma.on("enterNode", ({ node, event }) => latest.current.props.onHoverNode(node, { x: event.x, y: event.y }));
    sigma.on("leaveNode", () => latest.current.props.onHoverNode(null));
    sigma.on("clickNode", ({ node }) => latest.current.props.onClickNode(node));
    sigma.on("clickStage", () => latest.current.props.onClickStage());
    sigma.on("enterEdge", ({ edge, event }) => {
      const e = latest.current.visiblePairs.get(edge);
      if (e) latest.current.props.onHoverEdge({ kind: e.kind, evidence: e.evidence }, { x: event.x, y: event.y });
    });
    sigma.on("leaveEdge", () => latest.current.props.onHoverEdge(null));
    sigma.on("clickEdge", ({ edge }) => {
      const e = latest.current.visiblePairs.get(edge);
      if (e) latest.current.props.onClickEdge({ kind: e.kind, source: e.source, target: e.target });
    });

    const ro = new ResizeObserver(() => sigma.refresh());
    ro.observe(container);
    return () => {
      ro.disconnect();
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [props.graph, props.positions]);

  // Sigma reads positions from the graph itself (a reducer can't move a node),
  // so overrides are written onto the graph's node attributes, and the layout's
  // positions are written back when they lift.
  useEffect(() => {
    const g = sigmaRef.current?.getGraph();
    if (!g) return;
    const overrides = props.positionOverrides;
    g.updateEachNodeAttributes((id, attrs) => {
      const p = overrides?.get(id) ?? props.positions[id];
      return p ? { ...attrs, x: p.x, y: p.y } : attrs;
    });
  }, [props.positionOverrides, props.positions]);

  useEffect(() => {
    sigmaRef.current?.setSetting("labelColor", { color: colors.label });
  }, [colors]);

  // Every other prop change (and a theme switch) is a reducer refresh. The label grid depends on
  // node sizes, so the refresh reindexes rather than skipping it.
  useEffect(() => {
    sigmaRef.current?.refresh();
  });

  useImperativeHandle(ref, () => {
    const frameNodes = (ids: string[]) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;
      const pts = ids.map((id) => sigma.getNodeDisplayData(id)).filter((d): d is NodeDisplayData => !!d);
      if (pts.length === 0) return;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const extent = Math.max(maxX - minX, maxY - minY);
      // The set is centered in the part of the canvas the overlay doesn't
      // cover, so the frame shrinks to that width.
      const { width } = sigma.getDimensions();
      const inset = Math.min(latest.current.props.insetLeft ?? 0, width / 2);
      const usable = width > 0 ? (width - inset) / width : 1;
      // Display coordinates are normalized so ratio 1 frames the whole graph;
      // pad the set's extent, and hold a lone node at a readable zoom.
      const ratio = pts.length === 1 ? 0.22 : Math.min(1.1, Math.max(0.12, (extent * 1.15) / usable));
      // Shift the camera left by half the inset, measured in framed-graph
      // units per pixel at the target zoom (camera ratio scales them linearly).
      const camera = sigma.getCamera();
      const a = sigma.viewportToFramedGraph({ x: 0, y: 0 });
      const b = sigma.viewportToFramedGraph({ x: 100, y: 0 });
      const unitsPerPx = ((b.x - a.x) / 100) * (ratio / camera.getState().ratio);
      const x = (minX + maxX) / 2 - (inset / 2) * unitsPerPx;
      camera.animate({ x, y: (minY + maxY) / 2, ratio }, { duration: 450 });
    };
    return {
      frameNodes,
      fitAll: () => frameNodes([...latest.current.visibleIds]),
      zoom: (factor) => {
        const camera = sigmaRef.current?.getCamera();
        if (!camera) return;
        camera.animate({ ratio: camera.getState().ratio / factor }, { duration: 250 });
      },
    };
  }, []);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0, background: theme.ground }} />;
});

export default KnowledgeGraphCanvas;
