import { PayrollAnalysis } from './pay-comparison.models';

export interface Domain { name: string; label: string; domain: string; }
export interface Viewer { role: string; features: string[]; authMode: string; allowedModels?: string[] | null; allowedTools?: string[] | null; }
export interface Benchmark { name: string; score: string | number; source: string; }
export interface Model { id: string; name: string; provider: string; modelId?: string; details: {
  license?: string; vendor?: string; context_window?: string; description?: string; strengths?: string[]; benchmarks?: Benchmark[];
}; }
export interface Service { operations?: import('./agent-access.models').ApiOperation[]; id: string; name: string; enabled: boolean; method: string; path: string; baseUrlEnv: string; }
export interface AgentConfig {
  description: string; instructions: string; model: string; service: string; domain: string; page: string;
  questions: string[]; attached_services: string[]; capabilities?: { alerts?: { enabled: boolean; severity: string } };
  [key: string]: unknown;
}
export interface Agent { id: string; name: string; domainName: string; templateId: string; templateVersion: number; config: AgentConfig; modelConfig?: Partial<Model>; }
export interface Template { id: string; name: string; description: string; version: number; config: AgentConfig; modelOptions: Model[]; serviceOptions: Service[]; }
export interface Message { role: string; content: string; analysis?: PayrollAnalysis; }
export interface QuestionCandidate { id: string; text: string; distance: number; }
export interface QuestionMapping { id: string; originalQuery: string; candidates: QuestionCandidate[]; expiresAt: number; embeddingModel: string; }
export interface QuestionConfirmation { mappingId: string; questionId: string; }
export interface MappingReply { status?: string; questionMapping?: QuestionMapping; mappedQuestion?: QuestionCandidate & { originalQuery: string }; }
export interface ChatReply extends MappingReply { output: string; session?: { id: string }; analysis?: PayrollAnalysis; }
export interface WebhookReply extends MappingReply { reply: string; session?: { id: string }; analysis?: PayrollAnalysis; }
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please try again.';
