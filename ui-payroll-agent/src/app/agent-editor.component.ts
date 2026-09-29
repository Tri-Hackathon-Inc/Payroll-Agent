import { Component, Input, Output, EventEmitter, OnChanges, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError } from './api.service';
import { Agent, AgentConfig, Domain, Template, Viewer, Service, errorMessage } from './models';
import { ModelPickerComponent } from './model-picker.component';
import { CREATE_AGENT_MUTATION, UPDATE_AGENT_MUTATION, TEMPLATE_QUERY } from '../graphql/operations.js';

@Component({ selector: 'app-agent-editor', standalone: true, imports: [FormsModule, ModelPickerComponent], templateUrl: './agent-editor.component.html' })
export class AgentEditorComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) domain!: Domain;
  @Input({ required: true }) templateId = '';
  @Input() agent: Agent | null = null;
  @Input() viewer!: Viewer;
  @Output() saved = new EventEmitter<Agent>();
  @Output() cancel = new EventEmitter<void>();
  template: Template | null = null;
  config: AgentConfig | null = null;
  name = ''; error = ''; loadError = ''; saving = false; archived = false;
  private generation = 0;
  constructor(private api: ApiService) {}
  ngOnChanges(): void { void this.load(); }
  ngOnDestroy(): void { this.generation++; }
  async load(): Promise<void> {
    const generation = ++this.generation;
    this.config = null; this.template = null; this.loadError = ''; this.error = ''; this.archived = false;
    this.name = this.agent?.name || '';
    try {
      const { getTemplate: detail } = await this.api.graphql<{ getTemplate: Template }>(TEMPLATE_QUERY, { id: this.templateId });
      if (generation !== this.generation) return;
      if (detail.config.domain !== this.domain.domain) throw new Error('This template is not available for the selected domain.');
      this.template = { ...detail, modelOptions: detail.modelOptions.filter(m => !this.viewer?.allowedModels || this.viewer.allowedModels.includes(m.id)),
        serviceOptions: detail.serviceOptions.filter(s => !this.viewer?.allowedTools || this.viewer.allowedTools.includes(s.id)) };
      const config = structuredClone(this.agent?.config || detail.config);
      if (!this.agent) {
        if (!this.template.modelOptions.some(m => m.id === config.model) && this.template.modelOptions[0]) config.model = this.template.modelOptions[0].id;
        if (!this.template.serviceOptions.some(s => s.id === config.service) && this.template.serviceOptions[0]) config.service = this.template.serviceOptions[0].id;
        config.attached_services = config.attached_services.filter(id => this.template!.serviceOptions.some(s => s.id === id));
      }
      this.config = config; this.name = this.agent?.name || detail.name;
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.agent && error instanceof ApiError && error.code === 'NOT_FOUND') {
        this.template = { id: this.templateId, name: this.templateId, version: this.agent.templateVersion, description: '', config: this.agent.config, modelOptions: [], serviceOptions: [] };
        this.config = structuredClone(this.agent.config); this.archived = true;
      } else this.loadError = errorMessage(error);
    }
  }
  get services(): Service[] { return this.template?.serviceOptions || []; }
  get savedService(): boolean { return !this.services.some(s => s.id === this.config?.service); }
  get attachments(): { id: string; name: string }[] {
    return [...this.services, ...(this.config?.attached_services || []).filter(id => !this.services.some(s => s.id === id)).map(id => ({ id, name: `${id} (saved selection)` }))];
  }
  toggle(id: string, checked: boolean): void { if (this.config) this.config.attached_services = checked ? [...this.config.attached_services, id] : this.config.attached_services.filter(item => item !== id); }
  async submit(): Promise<void> {
    if (this.saving || !this.config) return;
    this.saving = true; this.error = '';
    try {
      const input = { domainName: this.domain.name, name: this.name.trim(), config: { ...this.config, questions: this.config.questions.map(q => q.trim()).filter(Boolean) },
        ...(this.agent ? { id: this.agent.id } : { templateId: this.templateId }) };
      const data = await this.api.graphql<{ createAgent?: Agent; updateAgent?: Agent }>(this.agent ? UPDATE_AGENT_MUTATION : CREATE_AGENT_MUTATION, { input });
      this.saved.emit((data.updateAgent || data.createAgent)!);
    } catch (error) { this.error = errorMessage(error); } finally { this.saving = false; }
  }
}
