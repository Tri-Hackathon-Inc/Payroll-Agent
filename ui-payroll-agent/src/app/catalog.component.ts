import { Component, Input, ViewChild, ElementRef } from '@angular/core';
import { Domain, Template, Agent, Model, Service } from './models';
import { TOOL_INFO } from './tool-info';

interface CatalogTool extends Service { primaryIn: string[]; attachedIn: string[]; }
interface CatalogModel extends Model { templates: string[]; }
@Component({ selector: 'app-catalog', standalone: true, templateUrl: './catalog.component.html' })
export class CatalogComponent {
  @Input() mode: 'models' | 'tools' = 'models';
  @Input() templates: Template[] = [];
  @Input() domain!: Domain;
  @Input() agents: Agent[] = [];
  @ViewChild('dialog') dialog?: ElementRef<HTMLDialogElement>;
  filter = 'all'; selected: CatalogTool | null = null;
  filters = [{ key: 'all', label: 'All' }, { key: 'open-source', label: 'Open source' }, { key: 'commercial', label: 'Commercial' }];
  get models(): CatalogModel[] {
    const map = new Map<string, CatalogModel>();
    for (const template of this.templates) for (const model of template.modelOptions) {
      const entry = map.get(model.id) || { ...model, templates: [] }; entry.templates.push(template.name); map.set(model.id, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  count(key: string): number { return this.models.filter(m => key === 'all' || m.details.license === key).length; }
  get visibleModels(): CatalogModel[] { return this.models.filter(m => this.filter === 'all' || m.details.license === this.filter); }
  sources(model: Model): string[] { return [...new Set((model.details.benchmarks || []).map(b => b.source))]; }
  get tools(): CatalogTool[] {
    const map = new Map<string, CatalogTool>();
    for (const template of this.templates.filter(t => t.config.domain === this.domain?.domain)) for (const service of template.serviceOptions) {
      const entry = map.get(service.id) || { ...service, primaryIn: [], attachedIn: [] };
      if (template.config.service === service.id) entry.primaryIn.push(template.name);
      else if (template.config.attached_services.includes(service.id)) entry.attachedIn.push(template.name);
      map.set(service.id, entry);
    }
    return [...map.values()];
  }
  info(tool: Service) { return TOOL_INFO[tool.id] || { icon: 'bi-plug', group: tool.method === 'GET' ? 'data' : 'action', status: 'catalog', description: '', via: '' }; }
  status(tool: Service): string { return ({ live: 'Live', configurable: 'Live when configured', catalog: 'Catalog only' })[this.info(tool).status] || 'Catalog only'; }
  usage(tool: CatalogTool): string { return tool.primaryIn.length ? `Primary API · ${tool.primaryIn.length} templates` : tool.attachedIn.length ? `Attached · ${tool.attachedIn.length} templates` : 'Not used by default'; }
  using(tool: Service): string { return this.agents.filter(a => a.config.service === tool.id || a.config.attached_services.includes(tool.id)).map(a => a.name).join(', ') || 'None yet'; }
  open(tool: CatalogTool): void { this.selected = tool; this.dialog?.nativeElement.showModal(); }
  close(): void { this.dialog?.nativeElement.close(); this.selected = null; }
}
