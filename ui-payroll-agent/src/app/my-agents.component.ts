import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Agent, Domain, Viewer, errorMessage } from './models';
import { AgentChatComponent } from './agent-chat.component';
import { AgentEditorComponent } from './agent-editor.component';
import { AgentPipelineComponent } from './agent-pipeline.component';
import { AgentHealthComponent } from './agent-health.component';
import { SERVICE_AGENT_REGISTRY_QUERY, DELETE_AGENT_MUTATION } from '../graphql/operations.js';

@Component({ selector: 'app-my-agents', standalone: true, imports: [FormsModule, AgentChatComponent, AgentEditorComponent, AgentPipelineComponent, AgentHealthComponent], templateUrl: './my-agents.component.html' })
export class MyAgentsComponent implements OnInit, OnDestroy {
  @Input() domains: Domain[] = [];
  @Input({ required: true }) viewer!: Viewer;
  @Input() readOnly = false;
  @Output() create = new EventEmitter<void>();
  @Output() changed = new EventEmitter<void>();
  agents: Agent[] = []; loading = true; search = ''; error = ''; notice = ''; deleting = '';
  chat: { agent: Agent; domain: Domain } | null = null;
  agentTab: 'chat' | 'pipeline' = 'chat';
  editing: { agent: Agent; domain: Domain } | null = null;
  private generation = 0;
  constructor(public api: ApiService) {}
  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.generation++; }
  has(feature: string): boolean { return !this.readOnly && this.viewer.features.includes(feature); }
  canChat(agent: Agent): boolean { return agent.templateId !== 'anomaly-detection' && !agent.config['anomaly']; }
  get groups(): { domain: Domain; agents: Agent[] }[] {
    const q = this.search.trim().toLowerCase();
    return this.domains.map(domain => ({ domain, agents: this.agents.filter(agent => agent.domainName === domain.name && (!q || [agent.name, agent.templateId, agent.config.description].some(value => value?.toLowerCase().includes(q)))) }));
  }
  runtime(agent: Agent): string {
    if (/anomaly/i.test(agent.templateId)) return 'REAL-TIME';
    if (/summar/i.test(agent.templateId)) return 'OFFLINE';
    if (/incident/i.test(agent.templateId)) return 'EVENT-DRIVEN';
    return 'INTERACTIVE';
  }
  async load(): Promise<void> {
    const generation = ++this.generation; this.loading = true; this.error = '';
    try { const data = await this.api.graphql<{ getServiceAgentRegistry: Agent[] }>(SERVICE_AGENT_REGISTRY_QUERY); if (generation === this.generation) this.agents = data.getServiceAgentRegistry; }
    catch (error) { if (generation === this.generation) this.error = errorMessage(error); }
    finally { if (generation === this.generation) this.loading = false; }
  }
  saved(agent: Agent): void { this.agents = this.agents.map(item => item.id === agent.id ? agent : item); this.editing = null; this.notice = `Saved "${agent.name}".`; this.changed.emit(); }
  async remove(agent: Agent, domain: Domain): Promise<void> {
    if (this.deleting || !this.has('manageAgents') || !confirm(`Delete "${agent.name}"? This permanently removes the agent and cannot be undone.`)) return;
    this.deleting = agent.id; this.error = ''; this.notice = '';
    try {
      const result = await this.api.graphql<{ deleteAgent: boolean }>(DELETE_AGENT_MUTATION, { id: agent.id, domainName: domain.name });
      if (!result.deleteAgent) throw new Error('The agent could not be deleted.');
      this.agents = this.agents.filter(item => item.id !== agent.id); this.notice = `Deleted "${agent.name}".`; this.changed.emit();
    } catch (error) { this.error = errorMessage(error); } finally { this.deleting = ''; }
  }
}
