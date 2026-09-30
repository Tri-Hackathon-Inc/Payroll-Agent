import { Domain, WebhookReply } from '../../app/models';

export interface Employee { employeeId: string; name: string; }
export interface PayrunHostContext {
  domain: Domain;
  payrun: { id: string; employees: Employee[] };
  employeeId: string;
  open: boolean;
  studioUrl: string;
}
export interface Screenshot { label: string; dataUrl: string; }
export interface Incident {
  id: string; title: string; severity: string; totalAtRisk: number; writtenBy: string; report: string;
  evidence: { id: string; name: string; finding: string; amountAtRisk?: number; screenshots?: Screenshot[] }[];
  screenshots?: { taken?: number; error?: string };
  email?: { status: string; to: string; reason?: string };
  slack?: { status: string; reason?: string };
  modelError?: string;
}
export interface PayrunReply extends WebhookReply {
  analysis?: { modelStatus?: string };
  retrieval?: { sources?: { id: string; employeeId: string; payrunId: string; topic: string; cited?: boolean }[] };
  answeredBy?: string; model?: { name: string }; metrics?: { latencyMs?: number };
  cached?: boolean; check?: { checked?: boolean; ok?: boolean };
  interactionId?: string; incident?: Incident;
  incidentAlert?: {
    review?: boolean; note?: string; alreadyRaised?: number; suggested?: { name: string; kind: string }[];
    raised?: { findings: unknown[]; agent: { name: string }; reply: string; incident: Incident };
  };
}
export interface ReplySource { kind: string; label: string; checked?: boolean; }
export interface ConversationMessage {
  id: string; role: 'user' | 'agent' | 'handoff' | 'incident'; text: string; scope: string; agent?: string;
  modelStatus?: string; sources?: NonNullable<PayrunReply['retrieval']>['sources'];
  source?: ReplySource; interactionId?: string; rating?: string; ratingBusy?: boolean;
  incident?: Incident; suggested?: { name: string; kind: string }[]; alreadyRaised?: number; alertNote?: string;
}
