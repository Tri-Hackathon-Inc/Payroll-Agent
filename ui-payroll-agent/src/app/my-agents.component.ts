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
  selected = new Set<string>();
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
    try { const data = await this.api.graphql<{ getServiceAgentRegistry: Agent[] }>(SERVICE_AGENT_REGISTRY_QUERY); if (generation === this.generation) { this.agents = data.getServiceAgentRegistry; this.selected = new Set([...this.selected].filter(id => this.agents.some(a => a.id === id))); } }
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
      this.agents = this.agents.filter(item => item.id !== agent.id); this.selected.delete(agent.id); this.notice = `Deleted "${agent.name}".`; this.changed.emit();
    } catch (error) { this.error = errorMessage(error); } finally { this.deleting = ''; }
  }
  get visibleAgents(): Agent[] { return this.groups.flatMap(group => group.agents); }
  get allSelected(): boolean { return !!this.visibleAgents.length && this.visibleAgents.every(agent => this.selected.has(agent.id)); }
  get someSelected(): boolean { return this.visibleAgents.some(agent => this.selected.has(agent.id)) && !this.allSelected; }
  select(agent: Agent, checked: boolean): void { if (checked) this.selected.add(agent.id); else this.selected.delete(agent.id); }
  selectAll(checked: boolean): void { for (const agent of this.visibleAgents) this.select(agent, checked); }
  async removeSelected(): Promise<void> {
    if (this.deleting || this.loading || !this.has('manageAgents')) return;
    const agents = this.agents.filter(agent => this.selected.has(agent.id));
    if (!agents.length || !confirm(`Delete ${agents.length} selected agent(s)?\n\n${agents.map(agent => agent.name).join('\n')}\n\nThis permanently removes these agents and their access memberships. This cannot be undone.`)) return;
    this.deleting = 'selected'; this.error = ''; this.notice = '';
    let removed = 0;
    const failures: string[] = [];
    try {
      for (const agent of agents) {
        try {
          const result = await this.api.graphql<{deleteAgent:boolean}>(DELETE_AGENT_MUTATION, {id:agent.id, domainName:agent.domainName});
          if (!result.deleteAgent) throw new Error('The agent could not be deleted.');
          this.agents = this.agents.filter(item => item.id !== agent.id);
          this.selected.delete(agent.id); removed++;
        } catch(error) { failures.push(`${agent.name}: ${errorMessage(error)}`); }
      }
      if (removed) { this.notice = `Deleted ${removed} agent${removed === 1 ? '' : 's'}.`; this.changed.emit(); }
      if (failures.length) this.error = `Some agents could not be deleted. They remain selected. ${failures.join(' ')}`;
    } finally { this.deleting = ''; }
  }

}
