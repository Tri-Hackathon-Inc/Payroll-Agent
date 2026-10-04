import { Component, Input, OnChanges, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService } from './api.service';
import { Agent, Domain, errorMessage } from './models';
import { AGENT_METRICS_QUERY } from '../graphql/operations.js';

interface Metrics {
  summary: Record<string, number | null>;
  business: { findings?: Record<string, number>; amountAtRisk?: number; incidentsRaised?: number; realtimeIncidents?: number; realtimeChecks?: number; manualIncidents?: number; warningsSuggested?: number; topQuestions: { question: string; count: number }[] };
  quality?: { checkPassRate: number | null; checked: number; flagged: number; consistencyRate: number | null; repeatedQuestions: number; consistent: number; cacheHitRate: number | null; cached: number; modelAnswers: number; errorReasons: { reason: string }[]; variedAnswers: { agentName: string; payrunId: string; question: string; times: number; distinctAnswers: number; answeredBy: string[] }[] };
  answerTypes?: { type: string; count: number; avgLatencyMs: number }[];
  timeline?: { bucket: string; questions: number; errors: number }[];
  agents?: { agentId: string; name: string; templateId: string; questions: number; dataShare: number; avgLatencyMs: number; p95LatencyMs: number; helpfulRate: number; flagged: number; incidents: number; errors: number }[];
  models?: { modelId: string; calls: number; avgLatencyMs: number; p95LatencyMs: number; promptTokens: number; completionTokens: number; errors: number }[];
  recent: { id: string; createdAt: string; agentName: string; question: string; feedback: string; answeredBy?: string; latencyMs?: number; error?: string; checkStatus?: string; modelId?: string }[];
}
interface Kpi { label: string; value: string; detail?: string; }
@Component({ selector: 'app-metrics', standalone: true, imports: [FormsModule, DatePipe], templateUrl: './metrics.component.html' })
export class MetricsComponent implements OnChanges, OnDestroy {
  @Input() domain!: Domain; @Input() agents: Agent[] = [];
  metrics: Metrics | null = null; hours = 168; agentId = ''; loading = false; error = '';
  ranges = [{ hours: 24, label: 'Last 24 hours' }, { hours: 168, label: 'Last 7 days' }, { hours: 720, label: 'Last 30 days' }, { hours: 0, label: 'All time' }];
  private generation = 0; private lastDomain = '';
  constructor(public api: ApiService) {}
  ngOnChanges(): void { if (this.domain.name !== this.lastDomain) { this.lastDomain = this.domain.name; this.agentId = ''; void this.load(); } }
  ngOnDestroy(): void { this.generation++; }
  async load(): Promise<void> {
    const generation = ++this.generation; this.loading = true; this.error = '';
    try { const data = await this.api.graphql<{ agentMetrics: Metrics }>(AGENT_METRICS_QUERY, { domainName: this.domain.name, agentId: this.agentId || null, sinceHours: Number(this.hours) }); if (generation === this.generation) this.metrics = data.agentMetrics; }
    catch (error) { if (generation === this.generation) { this.error = errorMessage(error); this.metrics = null; } }
    finally { if (generation === this.generation) this.loading = false; }
  }
  number(value: number | null | undefined): string { return Number(value || 0).toLocaleString('en-US'); }
  pct(value: number | null | undefined): string { return value == null ? '—' : `${Math.round(value * 100)}%`; }
  duration(value: number | null | undefined): string { return value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`; }
  dollars(value?: number): string { return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
  get usageOnly(): boolean { return !!this.metrics && !this.metrics.quality; }
  get kpis(): Kpi[] {
    if (!this.metrics) return [];
    const { summary: s, business: b, quality: q } = this.metrics;
    const common = [{ label: 'Questions asked', value: this.number(s['questions']), detail: `${this.number(s['conversations'])} conversations` }, { label: 'Agents used', value: this.number(s['activeAgents']) }, { label: 'Helpful rate', value: this.pct(s['helpfulRate']), detail: `${this.number(s['up'])} up · ${this.number(s['down'])} down` }];
    if (!q) return common;
    return [...common, { label: 'Payruns reviewed', value: this.number(s['payrunsReviewed']) }, { label: 'Findings surfaced', value: this.number(Object.values(b.findings || {}).reduce((sum, value) => sum + value, 0)), detail: Object.entries(b.findings || {}).map(([severity, count]) => `${count} ${severity}`).join(' · ') },
      { label: 'Dollars at risk flagged', value: this.dollars(b.amountAtRisk) }, { label: 'Incidents raised', value: this.number(b.incidentsRaised), detail: `${b.realtimeIncidents || 0} from ${b.realtimeChecks || 0} automatic checks · ${b.manualIncidents || 0} manual · ${b.warningsSuggested || 0} warnings suggested` },
      { label: 'Answered from data', value: this.pct(s['dataShare']) }, { label: 'Response time', value: this.duration(s['avgLatencyMs']), detail: `p95 ${this.duration(s['p95LatencyMs'])}` }, { label: 'Reply check pass rate', value: this.pct(q.checkPassRate), detail: `${q.flagged} of ${q.checked} flagged` },
      { label: 'Answer consistency', value: this.pct(q.consistencyRate), detail: `${q.consistent} of ${q.repeatedQuestions} repeated questions` }, { label: 'Cache hit rate', value: this.pct(q.cacheHitRate), detail: `${q.cached} of ${q.modelAnswers} model answers` }, { label: 'Errors', value: this.number(s['errors']), detail: q.errorReasons[0]?.reason || 'None' }];
  }
  get timelineMax(): number { return Math.max(1, ...(this.metrics?.timeline || []).map(p => p.questions)); }
  get questionMax(): number { return Math.max(1, ...(this.metrics?.business.topQuestions || []).map(p => p.count)); }
  typeLabel(type?: string): string { return ({ 'payroll-data': 'Computed from payroll data', model: 'Written by a model', rag: 'Payroll history search (RAG)', 'anomaly-pipeline': 'Anomaly pipeline', 'incident-report': 'Incident report', acknowledged: 'Acknowledged', error: 'Error' } as Record<string, string>)[type || ''] || type || '—'; }
}
