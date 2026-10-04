export interface PipelineStage { id: string; label: string; status: string; detail: string; }
export interface PipelineFeature {
  name: string; scope: Record<string, unknown>; current: unknown; unit: string;
  baseline: number | null; baselineKind: string; historyCount: number; details: Record<string, unknown>;
}
export interface PipelineCheck {
  id: string; entityId: string; entityType: string; version: number; decision: string; createdAt: string;
  reviewStatus: string; tenant?: string; summary?: string;
  investigation?: { summary?: string; reason?: string; modelStatus?: string; findings?: { explanation: string; reviewAction: string }[] };
  feedback?: { action: string; note: string; createdAt: string };
}
export interface AgentPipeline {
  agentId: string; agentName: string; kind: 'anomaly' | 'conversation'; profile: string; updatedAt: string;
  model: { name: string; provider: string; enabled: boolean }; components: Record<string, string>;
  checks: PipelineCheck[]; check: PipelineCheck | null; stages: PipelineStage[];
  features: { rows: PipelineFeature[]; total: number; truncated: boolean };
  canReview: boolean; configurationChanged: boolean; audit: { action: string; createdAt: string }[];
  decisionModelSetup?: { status: string; reason: string };
  decisionModel?: { status: string; model: string; decision?: string; score?: number; confidence?: number; probabilities?: Record<string, number> };
}
