import { Component, Input, Output, EventEmitter, OnChanges, OnDestroy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Agent, Domain, errorMessage } from './models';
import { AgentPipeline, PipelineFeature, PipelineStage } from './agent-pipeline.models';
import { AGENT_PIPELINE_QUERY } from '../graphql/operations.js';

@Component({ selector: 'app-agent-pipeline', standalone: true, imports: [FormsModule, DatePipe],
  templateUrl: './agent-pipeline.component.html', styleUrl: './agent-pipeline.component.css' })
export class AgentPipelineComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) agent!: Agent;
  @Input({ required: true }) domain!: Domain;
  @Output() back = new EventEmitter<void>();
  pipeline: AgentPipeline | null = null;
  selectedStage = '';
  get activeStage(): PipelineStage | undefined {
    const stages = this.pipeline?.stages || [];
    return stages.find(stage => stage.id === this.selectedStage) || stages.find(stage => !['completed', 'not_required', 'disabled'].includes(stage.status)) || stages[0];
  }
  selectedCheck = ''; search = ''; error = ''; actionError = ''; loading = false; reviewing = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private api: ApiService) {}
  stageIcon(id: string): string {
    return ({ source: 'database-down', features: 'sliders', rules: 'shield-check', decision: 'signpost-split',
      review: 'person-check', llm: 'stars', result: 'clipboard2-check', query: 'search', response: 'chat-square-text' } as Record<string, string>)[id] || 'diagram-3';
  }
  stagePurpose(id: string): string {
    return ({ source: 'Collect', features: 'Measure', rules: 'Detect', decision: 'Decide', review: 'Review',
      llm: 'Explain', result: 'Resolve', query: 'Find evidence', response: 'Answer' } as Record<string, string>)[id] || 'Process';
  }
  get domainIcon(): string {
    const domain = `${this.domain.domain} ${this.domain.label}`.toLowerCase();
    return domain.includes('payroll') ? 'cash-stack' : domain.includes('leave') ? 'calendar2-check'
      : domain.includes('insurance') ? 'shield-plus' : domain.includes('benefit') ? 'heart-pulse' : 'diagram-3';
  }
  ngOnChanges(): void {
    this.generation++; clearTimeout(this.timer); this.pipeline = null; this.selectedCheck = ''; this.search = '';
    this.selectedStage = '';
    this.actionError = ''; this.reviewing = false; void this.load();
  }
  ngOnDestroy(): void { this.generation++; clearTimeout(this.timer); }
  status(value: string): string {
    return ({ awaiting_data: 'Awaiting data', not_configured: 'Not configured', not_recorded: 'Not recorded',
      not_required: 'Not required', completed: 'Completed', waiting: 'Waiting', running: 'Running',
      failed: 'Failed', unavailable: 'Unavailable', configured: 'Configured', disabled: 'Disabled',
      missing_credentials: 'API key required', authentication_failed: 'Access rejected', rate_limited: 'Rate limited',
      timeout: 'Timed out', invalid_response: 'Invalid response', input_too_large: 'Scope too large',
      unsupported_features: 'Unsupported features', invalid_configuration: 'Setup required', skipped: 'Skipped' } as Record<string, string>)[value] || value;
  }
  format(value: unknown): string {
    if (value === null || value === undefined) return '—';
    return typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value);
  }
  entries(value: Record<string, unknown>): { key: string; value: unknown }[] { return Object.entries(value).map(([key, value]) => ({ key, value })); }
  get features(): PipelineFeature[] {
    const term = this.search.toLowerCase().trim();
    return (this.pipeline?.features.rows || []).filter(row => !term || `${row.name} ${JSON.stringify(row.scope)}`.toLowerCase().includes(term));
  }
  selectCheck(): void { this.pipeline = null; this.actionError = ''; void this.load(); }
  async load(): Promise<void> {
    const generation = ++this.generation; clearTimeout(this.timer); this.loading = true; this.error = '';
    try {
      const data = await this.api.graphql<{ agentPipeline: AgentPipeline }>(AGENT_PIPELINE_QUERY,
        { domainName: this.domain.name, agentId: this.agent.id, anomalyId: this.selectedCheck || null });
      if (generation === this.generation) this.pipeline = data.agentPipeline;
    } catch (error) { if (generation === this.generation) this.error = errorMessage(error); }
    finally {
      if (generation === this.generation) {
        this.loading = false;
        this.timer = setTimeout(() => { if (!this.reviewing) void this.load(); }, 10000);
      }
    }
  }
  async review(): Promise<void> {
    const check = this.pipeline?.check;
    if (!check || !this.pipeline?.canReview || this.reviewing) return;
    // Pin the check the user authorized, even if another event arrives during investigation.
    this.selectedCheck = check.id; clearTimeout(this.timer);
    const generation = ++this.generation; this.loading = false; this.reviewing = true; this.actionError = '';
    try {
      const response = await fetch(this.api.url('anomalies/review'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainName: this.domain.name, agentId: this.agent.id, anomalyId: check.id, expectedVersion: check.version, action: 'REVIEW' }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `Review failed (${response.status}).`);
    } catch (error) { if (generation === this.generation) this.actionError = errorMessage(error); }
    finally { if (generation === this.generation) { this.reviewing = false; await this.load(); } }
  }
}
