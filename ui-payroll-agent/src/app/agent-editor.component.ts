import { AccessState, AccessPermission, ApiOperation, groupAllows } from './agent-access.models';
import { Component, Input, Output, EventEmitter, OnChanges, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ApiError } from './api.service';
import { Agent, AgentConfig, Domain, Template, Viewer, Service, errorMessage } from './models';
import { ModelPickerComponent } from './model-picker.component';
import { CREATE_AGENT_MUTATION, UPDATE_AGENT_MUTATION, TEMPLATE_QUERY } from '../graphql/operations.js';

@Component({ selector: 'app-agent-editor', standalone: true, imports: [FormsModule, ModelPickerComponent], templateUrl: './agent-editor.component.html', styleUrl: './agent-editor.component.css' })
export class AgentEditorComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) domain!: Domain;
  @Input({ required: true }) templateId = '';
  @Input() agent: Agent | null = null;
  @Input() viewer!: Viewer;
  @Output() saved = new EventEmitter<Agent>();
  @Output() cancel = new EventEmitter<void>();
  template: Template | null = null;
  config: AgentConfig | null = null;
  directPermissions: AccessPermission[] = []; contextSources: string[] = [];
  apiSource = 'payrun';
  roleIds: string[] = [];
  roleAllows(service:string,access:'R'|'W'):boolean {return !!this.accessState?.roleGroups.some(r=>this.roleIds.includes(r.id)&&r.permissions.some(p=>p.service===service&&(access==='R'?p.read:p.write)));}
  toggleRole(id:string,checked:boolean):void {this.roleIds=checked?[...this.roleIds,id]:this.roleIds.filter(x=>x!==id);}
  roleSummary(id:string):string {
    const permissions = this.accessState?.roleGroups.find(r=>r.id===id)?.permissions || [];
    const names = (write:boolean) => permissions.filter(p=>write?p.write:p.read).map(p=>this.services.find(s=>s.id===p.service)?.name || p.service).join(', ');
    return [names(false) ? 'Read: ' + names(false) : '', names(true) ? 'Write: ' + names(true) : ''].filter(Boolean).join(' / ') || 'No API permissions';
  }
  readonly payrollApiIds = ['payrun', 'payrun-history', 'employee-details'];
  get payrunAvailable(): boolean { return this.services.some(s => s.id === 'payrun'); }
  get missingPayrollReads(): string[] {
    if (this.attachedApp !== 'payrun' || !this.accessState) return [];
    return this.payrollApiIds.filter(id => !this.hasDirect(id, 'R') && !this.roleAllows(id, 'R') && !this.groupIds.some(g => groupAllows(this.accessState!, g, id, 'R')));
  }
  allowPayrollReads(): void {
    for (const id of this.missingPayrollReads) {
      if (this.services.some(s => s.id === id)) this.setDirect(id, {method: 'GET', path: '', access: 'R'}, true);
    }
  }
  get attachedApp(): string { return this.config?.page === 'payrun' ? 'payrun' : this.config?.page ? 'custom' : ''; }
  setApp(value: string): void {
    if (!this.config) return;
    this.config.page = value === 'payrun' ? 'payrun' : '';
    if (value === 'payrun') { this.config.service = 'payrun'; this.apiSource = 'payrun'; }
  }
  get backendServices(): Service[] { return this.services.filter(s => this.apiSource === 'payrun' ? this.payrollApiIds.includes(s.id) : !this.payrollApiIds.includes(s.id)); }
  groupRoles(id: string): string {
    const ids = this.accessState?.authorizations.filter(a => a.agentGroupId === id).map(a => a.roleGroupId) || [];
    return this.accessState?.roleGroups.filter(r => ids.includes(r.id)).map(r => r.name).join(', ') || 'No roles assigned';
  }
  accessState: AccessState | null = null; groupIds: string[] = []; accessError = '';
  name = ''; error = ''; loadError = ''; saving = false; archived = false;
  private generation = 0;
  constructor(private api: ApiService) {}
  goToSection(id: string): void {
    const section = document.getElementById(id);
    if (section) { section.tabIndex = -1; section.focus({preventScroll:true}); section.scrollIntoView({block:'start'}); }
  }
  ngOnChanges(): void { void this.load(); }
  ngOnDestroy(): void { this.generation++; }
  async load(): Promise<void> {
    const generation = ++this.generation;
    this.config = null; this.template = null; this.loadError = ''; this.error = ''; this.archived = false;
    this.name = this.agent?.name || '';
    this.accessState = null; this.roleIds = []; this.groupIds = []; this.directPermissions = []; this.contextSources = []; this.accessError = '';
    if (this.canManageAccess) void this.loadAccess(generation);
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
  get isAnomaly(): boolean { return this.templateId === 'anomaly-detection' || !!this.config?.['anomaly']; }
  get decisionModel(): string {
    const settings = this.config?.['anomaly'] as Record<string, string> | undefined;
    return settings?.['decisionModel'] || (!settings?.['profile'] || ['payroll', 'records'].includes(settings['profile']) ? 'jev' : 'none');
  }
  setDecisionModel(value: string): void { if (this.config) this.config['anomaly'] = { ...(this.config['anomaly'] as object || {}), decisionModel: value }; }
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
        ...(this.agent ? { id: this.agent.id } : { templateId: this.templateId }),
        ...(this.canManageAccess && this.accessState ? { agentGroupIds: this.groupIds, roleGroupIds: this.roleIds, apiPermissions: this.directPermissions, contextSourceIds: this.contextSources } : {}) };
      const data = await this.api.graphql<{ createAgent?: Agent; updateAgent?: Agent }>(this.agent ? UPDATE_AGENT_MUTATION : CREATE_AGENT_MUTATION, { input });
      this.saved.emit((data.updateAgent || data.createAgent)!);
    } catch (error) { this.error = errorMessage(error); } finally { this.saving = false; }
  }
  get canManageAccess(): boolean { return this.viewer?.role === 'admin' && this.viewer.features.includes('manageAgents'); }
  async loadAccess(generation = this.generation): Promise<void> {
    try {
      const data = await this.api.graphql<{agentAccess:AccessState}>('query($domainName:String!){agentAccess(domainName:$domainName)}',{domainName:this.domain.name});
      if (generation !== this.generation) return;
      this.accessState = data.agentAccess; this.accessError = '';
      this.roleIds = (data.agentAccess.roleAssignments || []).filter(a=>a.agentId===this.agent?.id).map(a=>a.roleGroupId);
      this.directPermissions = (data.agentAccess.apiPermissions || []).filter(p=>p.agentId===this.agent?.id).map(({service,read,write})=>({service,read,write}));
      this.contextSources = (data.agentAccess.contextPermissions || []).filter(p=>p.readerId===this.agent?.id).map(p=>p.sourceId);
      this.groupIds = this.agent ? data.agentAccess.agentGroups.filter(g=>g.agentIds.includes(this.agent!.id)).map(g=>g.id) : [];
    } catch(error) { if(generation===this.generation)this.accessError=errorMessage(error); }
  }
  toggleGroup(id:string,checked:boolean):void {this.groupIds=checked?[...this.groupIds,id]:this.groupIds.filter(x=>x!==id);}
  get apiPermissions() {
    return this.backendServices.flatMap(s=>(s.operations?.length?s.operations:[{method:s.method,path:s.path,access:s.method==='GET'?'R':'W'} as ApiOperation]).map(operation=>({service:s.id,name:s.name,...operation})));
  }
  grantedBy(service:string,operation:ApiOperation):string {
    if(!this.accessState)return 'Administrator-managed';
    return [...this.accessState.roleGroups.filter(r=>this.roleIds.includes(r.id)&&r.permissions.some(p=>p.service===service&&(operation.access==='R'?p.read:p.write))).map(r=>r.name),...this.accessState.agentGroups.filter(g=>this.groupIds.includes(g.id)&&groupAllows(this.accessState!,g.id,service,operation.access)).map(g=>g.name)].join(', ')||'Not granted';
  }

  get contextOptions() {return (this.accessState?.agents||[]).filter(a=>a.id!==this.agent?.id);}
  toggleContext(id:string,checked:boolean):void {this.contextSources=checked?[...this.contextSources,id]:this.contextSources.filter(x=>x!==id);}
  hasDirect(service:string,access:'R'|'W'):boolean {return this.directPermissions.some(p=>p.service===service&&(access==='R'?p.read:p.write));}
  setDirect(service:string,operation:ApiOperation,checked:boolean):void {
    let grant=this.directPermissions.find(p=>p.service===service);
    if(!grant){grant={service,read:false,write:false};this.directPermissions.push(grant);}
    if(operation.access==='R')grant.read=checked;else grant.write=checked;
    if(checked && this.config && this.config.service!==service && !this.config.attached_services.includes(service))this.config.attached_services.push(service);
  }

}
