import { AfterViewChecked, Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, requestId } from '../../app/api.service';
import { Agent, errorMessage } from '../../app/models';
import { SERVICE_AGENT_REGISTRY_QUERY } from '../../graphql/operations.js';
import { ConversationMessage, PayrunHostContext, PayrunReply } from './models';
import { PayrunApiService } from './payrun-api.service';

@Component({ selector: 'payrun-assistant', standalone: true, imports: [FormsModule],
  providers: [{ provide: ApiService, useClass: PayrunApiService }], templateUrl: './payrun-assistant.component.html' })
export class PayrunAssistantComponent implements OnInit, AfterViewChecked {
  @ViewChild('thread') thread?: ElementRef<HTMLElement>;
  host: PayrunHostContext | null = null;
  agents: Agent[] = []; agentId = ''; loading = true; loadError = '';
  messages: ConversationMessage[] = []; question = ''; error = ''; sending = false;
  private scrollPending = false; private loadGeneration = 0;
  readonly instance = new URLSearchParams(location.search).get('instance') || '';
  constructor(public api: ApiService) {}
  ngOnInit(): void { this.emit('ready'); }
  emit(type: string, detail: object = {}): void {
    if (parent !== window) parent.postMessage({ protocol: 'agent-ui-v1', instance: this.instance, type, ...detail }, location.origin);
  }
  @HostListener('window:message', ['$event']) receive(event: MessageEvent): void {
    // The supported embedding contract uses a same-origin proxy, and binds every message
    // to this frame instance. Other frames and origins cannot change payroll scope.
    if (event.source !== parent || event.origin !== location.origin || event.data?.protocol !== 'agent-ui-v1'
      || event.data.instance !== this.instance || event.data.type !== 'context') return;
    const next = event.data.context as PayrunHostContext;
    if (!next || typeof next.domain?.name !== 'string' || typeof next.payrun?.id !== 'string'
      || !Array.isArray(next.payrun.employees) || !next.payrun.employees.every(item => typeof item.employeeId === 'string' && typeof item.name === 'string')
      || typeof next.employeeId !== 'string' || typeof next.open !== 'boolean') return;
    const domainChanged = this.host?.domain.name !== next.domain.name;
    const changed = domainChanged || this.host?.payrun.id !== next.payrun.id;
    const reopened = next.open && !this.host?.open;
    this.host = { ...next, employeeId: next.payrun.employees.some(item => item.employeeId === next.employeeId) ? next.employeeId : '' };
    if (changed) { this.messages = []; this.error = ''; this.question = ''; }
    if (domainChanged) { this.agents = []; this.agentId = ''; }
    if (domainChanged || reopened) void this.loadAgents();
    this.scrollPending = true;
  }
  async loadAgents(): Promise<void> {
    if (!this.host) return;
    const generation = ++this.loadGeneration;
    this.loadError = ''; this.loading = true;
    try {
      const data = await this.api.graphql<{ getServiceAgentRegistry: Agent[] }>(SERVICE_AGENT_REGISTRY_QUERY, { domainName: this.host.domain.name });
      if (generation !== this.loadGeneration) return;
      const attached = data.getServiceAgentRegistry.filter(item => item.config?.page === 'payrun');
      this.agents = attached.filter(item => item.templateId === 'general-query' && !item.config['anomaly']);
      if (!this.agents.some(item => item.id === this.agentId)) this.agentId = this.agents[0]?.id || '';
    } catch (error) { if (generation === this.loadGeneration) this.loadError = errorMessage(error); }
    finally { if (generation === this.loadGeneration) this.loading = false; }
  }
  get agent(): Agent | undefined { return this.agents.find(item => item.id === this.agentId); }
  get employee() { return this.host?.payrun.employees.find(item => item.employeeId === this.host?.employeeId); }
  get context(): Record<string, unknown> { return { page: 'payrun', payrunId: this.host?.payrun.id, employeeId: this.host?.employeeId || null }; }
  get scope(): string { return this.host && this.agent ? this.api.sessionKey(this.host.domain, this.agent, this.context) : ''; }
  get visibleMessages(): ConversationMessage[] { return this.messages.filter(item => item.scope === this.scope); }
  get lastAgentMessage(): ConversationMessage | undefined { return this.visibleMessages.filter(item => item.role === 'agent' || item.role === 'incident').at(-1); }
  get busy(): boolean { return this.sending; }
  get studioUrl(): string {
    const url = new URL(this.host?.studioUrl || '../../', document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) return '../../';
    url.searchParams.set('domain', this.host?.domain.name || ''); return url.href;
  }
  selectEmployee(employeeId: string): void {
    if (!this.host || this.busy) return;
    this.host = { ...this.host, employeeId }; this.error = ''; this.scrollPending = true;
    this.emit('employee-change', { employeeId });
  }
  newChat(): void { this.api.store(this.scope); this.messages = this.messages.filter(item => item.scope !== this.scope); this.error = ''; }
  agentChanged(): void { this.error = ''; }
  @HostListener('document:keydown.escape') escape(): void { this.emit('close'); }
  ngAfterViewChecked(): void {
    if (this.scrollPending && this.thread) { const el = this.thread.nativeElement; el.scrollTop = el.scrollHeight; this.scrollPending = false; }
  }
  private append(...items: ConversationMessage[]): void { this.messages.push(...items); this.scrollPending = true; }
  async ask(text: string): Promise<void> {
    const question = text.trim(), agent = this.agent, host = this.host, scope = this.scope;
    if (!question || !agent || !host || this.busy) return;
    this.error = ''; this.sending = true; this.question = '';
    const messageId = requestId();
    this.append({ id: messageId, role: 'user', text: question, scope });
    try {
      const reply = await this.api.webhook(host.domain, agent, question, this.context, true, 'trinet-payrun-mock') as PayrunReply;
      if (reply.status === 'confirmation_required' && reply.questionMapping) {
        if (scope === this.scope) { this.error = 'Chat configuration changed. Reopen the assistant and retry your question.'; this.question = question; }
      } else this.renderReply(reply, agent, scope);
    } catch (error) { if (scope === this.scope) { this.error = errorMessage(error); this.question = question; } }
    finally { this.sending = false; this.scrollPending = true; }
  }
  private renderReply(reply: PayrunReply, agent: Agent, scope: string): void {
      this.append({ id: requestId(), role: 'agent', text: reply.reply, scope, agent: agent.name, mappedQuestion: reply.mappedQuestion?.text,
        modelStatus: reply.analysis?.modelStatus, analysis: reply.analysis, sources: reply.retrieval?.sources,
        interactionId: reply.interactionId, rating: '', suggested: reply.incidentAlert?.review ? reply.incidentAlert.suggested : [],
        alreadyRaised: reply.incidentAlert?.review && !reply.incidentAlert.raised ? reply.incidentAlert.alreadyRaised : 0,
        alertNote: reply.incidentAlert?.note });
  }
}
