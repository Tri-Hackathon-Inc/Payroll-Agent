import { Component, Input, OnChanges, OnDestroy } from '@angular/core';
import { ApiService } from './api.service';
import { Agent } from './models';

const QUERY = `query AgentHealth($domainName: String!, $agentId: ID) { agentHealth(domainName: $domainName, agentId: $agentId) }`;

@Component({ selector: 'app-agent-health', standalone: true,
  template: `<div class="health-control"><span class="agent-health" [class.live]="status === 'live'" [class.offline]="status === 'not_connected'" [title]="detail" role="status"><i class="bi bi-circle-fill" aria-hidden="true"></i>{{status === 'live' ? 'Live' : status === 'not_connected' ? 'Not connected' : 'Checking...'}}</span><button type="button" class="health-refresh" [disabled]="status === 'checking'" (click)="refresh()" [attr.aria-label]="'Check connection for ' + agent.name">Check again</button>@if(status === 'not_connected'){<small class="health-reason">{{reason}}</small>}</div>`,
  styles: [`.health-control{max-width:240px}.health-refresh{border:0;background:none;color:#345c89;font-size:12px;padding:4px 8px}.health-reason{display:block;font-size:12px;color:#943434;margin-top:4px}.agent-health {display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:20px;background:#f2f4f7;color:#576574;font-size:12px;white-space:nowrap}.agent-health i{font-size:7px}.live{color:#17663e;background:#eaf6ef}.offline{color:#a62c2c;background:#fff0f0}`] })
export class AgentHealthComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) agent!: Agent;
  reason = '';
  status = 'checking'; detail = 'Checking agent and service connectivity.';
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private api: ApiService) {}
  ngOnChanges(): void { this.refresh(); }
  refresh(): void { clearTimeout(this.timer); this.status = 'checking'; this.reason = ''; void this.check(++this.generation); }
  ngOnDestroy(): void { this.generation++; clearTimeout(this.timer); }
  async check(generation: number): Promise<void> {
    try {
      const data = await this.api.graphql<{ agentHealth: { items: { status: string; reason: string; checkedAt: string }[]; scope: string } }>(QUERY, { domainName: this.agent.domainName, agentId: this.agent.id }, AbortSignal.timeout(10000));
      if (generation !== this.generation) return;
      const health = data.agentHealth.items[0];
      this.status = health?.status || 'not_connected';
      this.reason = health?.reason || 'No attached service was found.';
      this.detail = health ? `${health.reason} Checked ${new Date(health.checkedAt).toLocaleTimeString()}. ${data.agentHealth.scope}` : 'No attached service was found.';
    } catch { if (generation === this.generation) { this.status = 'not_connected'; this.reason = 'Health check unavailable. Check again to retry.'; this.detail = this.reason; } }
    finally { if (generation === this.generation) this.timer = setTimeout(() => void this.check(generation), 30000); }
  }
}
