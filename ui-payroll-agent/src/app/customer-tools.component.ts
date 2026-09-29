import { Component, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Agent, Domain, Template, Viewer, Service, errorMessage } from './models';
import { UPDATE_AGENT_MUTATION } from '../graphql/operations.js';
@Component({ selector: 'app-customer-tools', standalone: true, imports: [FormsModule], templateUrl: './customer-tools.component.html' })
export class CustomerToolsComponent {
  @Input() domain!: Domain; @Input() templates: Template[] = []; @Input() agents: Agent[] = []; @Input() viewer!: Viewer;
  @Output() changed = new EventEmitter<void>();
  adding: Record<string, string> = {}; saving = ''; error = '';
  constructor(private api: ApiService) {}
  tools(agent: Agent): Service[] { return this.templates.find(t => t.id === agent.templateId)?.serviceOptions || []; }
  name(agent: Agent, id: string): string { return this.tools(agent).find(t => t.id === id)?.name || id; }
  available(agent: Agent): Service[] { return this.tools(agent).filter(t => (!this.viewer.allowedTools || this.viewer.allowedTools.includes(t.id)) && t.id !== agent.config.service && !agent.config.attached_services.includes(t.id)); }
  async attach(agent: Agent): Promise<void> {
    const id = this.adding[agent.id]; if (!id || this.saving) return; this.saving = agent.id; this.error = '';
    try { await this.api.graphql(UPDATE_AGENT_MUTATION, { input: { id: agent.id, domainName: this.domain.name, name: agent.name, config: { attached_services: [...agent.config.attached_services, id] } } }); this.adding[agent.id] = ''; this.changed.emit(); }
    catch (error) { this.error = `${agent.name}: ${errorMessage(error)}`; } finally { this.saving = ''; }
  }
}
