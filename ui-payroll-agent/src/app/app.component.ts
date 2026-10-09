import { AccessControlComponent } from './access-control.component';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Agent, Domain, Template, Viewer, errorMessage } from './models';
import { AgentEditorComponent } from './agent-editor.component';
import { MyAgentsComponent } from './my-agents.component';
import { CatalogComponent } from './catalog.component';
import { CustomerToolsComponent } from './customer-tools.component';
import { EvaluationComponent } from './evaluation.component';
import { MetricsComponent } from './metrics.component';
import { ChatWindowComponent } from './chat-window.component';
import { STUDIO_QUERY, DOMAIN_TEMPLATES_QUERY, SERVICE_AGENT_REGISTRY_QUERY, VIEWER_QUERY } from '../graphql/operations.js';

interface NavItem { key: string; label: string; icon: string; }
const SERVICES = [
  { category: 'Payroll', icon: 'bi-cash-coin', description: 'Payrun anomalies, summaries, and payroll questions.' },
  { category: 'Benefits', icon: 'bi-heart-pulse', description: 'Stock matching, HSA, and other benefits questions.' },
  { category: 'Insurance', icon: 'bi-shield-check', description: 'Coverage, claims, and policy questions.' },
  { category: 'HR', icon: 'bi-people', description: 'Policies, onboarding, and general people questions.' },
  { category: 'Time off', icon: 'bi-calendar-week', description: 'PTO balances, requests, and time-off policy.' },
];
@Component({ selector: 'app-root', standalone: true,
  imports: [AccessControlComponent, FormsModule, AgentEditorComponent, MyAgentsComponent, CatalogComponent, CustomerToolsComponent, EvaluationComponent, MetricsComponent, ChatWindowComponent],
  templateUrl: './app.component.html' })
export class AppComponent implements OnInit {
  viewer: Viewer | null = null; domains: Domain[] = []; templates: Template[] = []; agents: Agent[] = [];
  loading = true; agentsLoading = false; error = ''; agentsError = ''; view = 'studio'; service = ''; domainName = ''; editing = ''; notice = '';
  loginOpen = false; adminKey = ''; accessError = ''; accessBusy = false;
  private agentRequest = 0;
  readonly params = new URLSearchParams(location.search);
  readonly standalone = this.params.get('view') === 'chat';
  readonly chatDomain = this.params.get('domain') || this.params.get('business') || '';
  constructor(public api: ApiService) {}
  ngOnInit(): void { if (!this.standalone) { void this.loadViewer(); void this.load(); } }
  has(feature: string): boolean { return !!this.viewer?.features.includes(feature); }
  get nav(): { label: string; items: NavItem[] }[] {
    if (!this.viewer) return [];
    const build: NavItem[] = [], manage: NavItem[] = [];
    if (this.has('manageAgents') || this.has('createAgents')) build.push({ key: 'studio', label: 'Services', icon: 'bi-grid-1x2' });
    if (this.has('tools') || this.has('agentTools')) build.push({ key: this.has('tools') ? 'tools' : 'agent-tools', label: 'Tools & APIs', icon: 'bi-plug' });
    if (this.has('models')) build.push({ key: 'models', label: 'Models', icon: 'bi-cpu' });
    if (this.has('manageAgents') || this.has('testAgents')) manage.push({ key: 'agents', label: 'My Agents', icon: 'bi-robot' });
    if (this.viewer.role === 'admin' && this.has('manageAgents')) manage.push({ key: 'access', label: 'Access control', icon: 'bi-shield-lock' });
    if (this.has('evaluation')) manage.push({ key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up' });
    if (this.has('metrics') || this.has('usage')) manage.push({ key: this.has('metrics') ? 'metrics' : 'usage', label: this.has('metrics') ? 'Agent Metrics' : 'Usage', icon: 'bi-bar-chart' });
    const groups = [{ label: 'Build', items: build }, { label: 'Manage', items: manage }].filter(g => g.items.length);
    return groups.length ? groups : [{ label: 'Your service', items: [{ key: 'mine', label: 'My Agents', icon: 'bi-robot' }] }];
  }
  get availableDomains(): Domain[] { return this.view === 'studio' ? this.domains.filter(d => d.domain === this.service) : this.domains; }
  get domain(): Domain | undefined { return this.availableDomains.find(d => d.name === this.domainName) || this.availableDomains[0]; }
  get visibleTemplates(): Template[] { return this.templates.filter(t => t.config.domain === this.domain?.domain); }
  get showDomain(): boolean { return !['models', 'agents', 'mine'].includes(this.view) && !!this.domain && (this.view !== 'studio' || !!this.service); }
  get categories() {
    const categories = [...SERVICES, ...[...new Set(this.domains.map(d => d.domain))].filter(name => !SERVICES.some(s => s.category === name)).map(category => ({ category, icon: 'bi-grid', description: `${category} agents.` }))];
    return categories.map(item => ({ ...item, count: this.templates.filter(t => t.config.domain === item.category).length }));
  }
  async loadViewer(): Promise<void> {
    try { this.viewer = (await this.api.graphql<{ viewer: Viewer }>(VIEWER_QUERY)).viewer; }
    catch { this.viewer = { role: 'user', features: [], authMode: 'key' }; }
    if (!this.nav.flatMap(g => g.items).some(item => item.key === this.view)) this.navigate(this.nav[0].items[0].key);
  }
  async load(): Promise<void> {
    this.loading = true; this.error = '';
    try {
      const { listDomains } = await this.api.graphql<{ listDomains: Domain[] }>(STUDIO_QUERY);
      const data = await Promise.all(listDomains.map(d => this.api.graphql<{ getDomainAgentsTemplates: Template[] }>(DOMAIN_TEMPLATES_QUERY, { domainName: d.name })));
      this.domains = listDomains; this.templates = [...new Map(data.flatMap(d => d.getDomainAgentsTemplates).map(t => [t.id, t])).values()];
      await this.loadAgents();
    } catch (error) { this.error = errorMessage(error); } finally { this.loading = false; }
  }
  async loadAgents(): Promise<void> {
    const generation = ++this.agentRequest;
    if (!this.domain || !['tools', 'agent-tools', 'evaluation', 'metrics', 'usage'].includes(this.view)) return;
    this.agentsLoading = true; this.agentsError = ''; this.agents = [];
    try { const data = await this.api.graphql<{ getServiceAgentRegistry: Agent[] }>(SERVICE_AGENT_REGISTRY_QUERY, { domainName: this.domain.name }); if (generation === this.agentRequest) this.agents = data.getServiceAgentRegistry; }
    catch (error) { if (generation === this.agentRequest) this.agentsError = errorMessage(error); }
    finally { if (generation === this.agentRequest) this.agentsLoading = false; }
  }
  navigate(view: string): void { this.view = view; this.editing = ''; this.notice = ''; if (view === 'studio') this.service = ''; void this.loadAgents(); window.scrollTo({ top: 0 }); }
  openService(category = ''): void { this.view = 'studio'; this.service = category; this.domainName = ''; this.editing = ''; this.notice = ''; }
  chooseDomain(name: string): void { this.domainName = name; this.editing = ''; this.notice = ''; void this.loadAgents(); }
  configure(id: string): void { this.editing = id; this.notice = ''; setTimeout(() => document.getElementById('configure')?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }
  saved(agent: Agent): void { this.editing = ''; this.notice = `${agent.name} created for ${this.domain?.label}. It is now available to the ${this.domain?.domain} service.`; void this.loadAgents(); window.scrollTo({ top: 0 }); }
  async access(logout = false): Promise<void> {
    if (this.accessBusy) return; this.accessBusy = true; this.accessError = '';
    try { await this.api.access(logout ? 'logout' : 'admin', logout ? {} : { key: this.adminKey }); this.adminKey = ''; this.loginOpen = false; this.editing = ''; await this.loadViewer(); }
    catch (error) { this.accessError = errorMessage(error); } finally { this.accessBusy = false; }
  }
}
