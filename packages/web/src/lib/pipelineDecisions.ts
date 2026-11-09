/** A pipeline decision Persona made, or a pipeline config change, as GET /api/pipeline/decisions returns it. */
export interface PipelineDecisionRecord {
  id: string;
  owner: string;
  runId?: string;
  jobId?: string;
  projectId?: string;
  stage?: string;
  kind: "skip" | "waive" | "close_out" | "escalate" | "accept_wontfix" | "not_applicable" | "config" | "park" | "unpark";
  reason: string;
  actor: string;
  detail?: unknown;
  createdAt: string;
}

const DECISION_LABEL: Record<PipelineDecisionRecord["kind"], string> = {
  skip: "Skipped",
  waive: "Waived",
  close_out: "Closed out",
  escalate: "Escalated to you",
  accept_wontfix: "Accepted wontfix",
  not_applicable: "Not applicable",
  config: "Changed the pipeline",
  park: "Parked the worker",
  unpark: "Un-parked the worker",
};

/** How a decision reads in a list: a worker's park of its own run reads as the worker's, not Persona's. */
export function decisionLabel(d: Pick<PipelineDecisionRecord, "kind" | "detail">): string {
  const by = d.detail && typeof d.detail === "object" ? (d.detail as { by?: unknown }).by : undefined;
  if (d.kind === "park" && by === "worker") return "Worker parked itself";
  return DECISION_LABEL[d.kind] ?? d.kind;
}

/** `decisions` newest first. */
export function newestFirst(decisions: PipelineDecisionRecord[]): PipelineDecisionRecord[] {
  return decisions.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
