import { AfterViewChecked, Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, requestId } from '../../app/api.service';
import { Agent, QuestionMapping, errorMessage } from '../../app/models';
import { QuestionConfirmationComponent } from '../../app/question-confirmation.component';
import { RATE_ANSWER_MUTATION, SERVICE_AGENT_REGISTRY_QUERY } from '../../graphql/operations.js';
import { QUESTION_BANK } from '../../questionBank.js';
import { IncidentComponent } from './incident.component';
import { ConversationMessage, PayrunHostContext, PayrunReply, ReplySource } from './models';
import { PayrunApiService } from './payrun-api.service';

const QUESTIONS = ['Which payments need review?', 'How does this payrun compare to the previous one?',
  'What is the total net pay for this payrun?', 'Who worked overtime this payrun?',
  'Is anyone paid after their termination date?', 'What should I check before approving this payrun?'];
const LIBRARY = QUESTION_BANK.map(group => ({ category: group.category, prompts: group.questions.map(item => item.prompt) }));

@Component({ selector: 'payrun-assistant', standalone: true, imports: [FormsModule, IncidentComponent, QuestionConfirmationComponent],
  providers: [{ provide: ApiService, useClass: PayrunApiService }], templateUrl: './payrun-assistant.component.html' })
export class PayrunAssistantComponent implements OnInit, AfterViewChecked {
  @ViewChild('thread') thread?: ElementRef<HTMLElement>;
  @ViewChild('libraryElement') libraryElement?: ElementRef<HTMLElement>;
  @ViewChild('browseButton') browseButton?: ElementRef<HTMLElement>;
  host: PayrunHostContext | null = null;
  agents: Agent[] = []; incidentAgent?: Agent; agentId = ''; loading = true; loadError = '';
  messages: ConversationMessage[] = []; question = ''; error = ''; sending = false; handingOff = false;
  pending: { mapping: QuestionMapping; scope: string; messageId: string; requestId: string } | null = null;
  libraryOpen = false; librarySearch = ''; private scrollPending = false; private loadGeneration = 0;
  readonly questionCount = LIBRARY.reduce((count, group) => count + group.prompts.length, 0);
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
    if (changed) { this.messages = []; this.error = ''; this.question = ''; this.closeLibrary(); }
    if (domainChanged) { this.agents = []; this.agentId = ''; this.incidentAgent = undefined; }
    if (this.pending?.scope !== this.scope) this.pending = null;
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
      this.agents = attached.filter(item => item.templateId !== 'incident-report');
      this.incidentAgent = attached.find(item => item.templateId === 'incident-report');
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
  get busy(): boolean { return this.sending || this.handingOff; }
  get suggestions(): string[] {
    const asked = new Set(this.visibleMessages.filter(item => item.role === 'user').map(item => item.text));
    return [...new Set([...(this.agent?.config.questions || []), ...QUESTIONS])].filter(item => !asked.has(item)).slice(0, 4);
  }
  get library() {
    const query = this.librarySearch.trim().toLowerCase();
    return LIBRARY.map(group => ({ ...group, prompts: group.prompts.filter(item => item.toLowerCase().includes(query)) })).filter(group => group.prompts.length);
  }
  get studioUrl(): string {
    const url = new URL(this.host?.studioUrl || '../../', document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) return '../../';
    url.searchParams.set('domain', this.host?.domain.name || ''); return url.href;
  }
  selectEmployee(employeeId: string): void {
    if (!this.host || this.busy) return;
    this.host = { ...this.host, employeeId }; this.pending = null; this.error = ''; this.scrollPending = true;
    this.emit('employee-change', { employeeId });
  }
  newChat(): void { this.api.store(this.scope); this.pending = null; this.messages = this.messages.filter(item => item.scope !== this.scope); this.error = ''; }
  agentChanged(): void { this.pending = null; this.error = ''; }
  revise(): void {
    if (!this.pending || this.busy) return;
    this.question = this.pending.mapping.originalQuery;
    this.messages = this.messages.filter(item => item.id !== this.pending?.messageId);
    this.pending = null; this.error = '';
  }
  async confirm(questionId: string): Promise<void> {
    const pending = this.pending, agent = this.agent, host = this.host;
    if (!pending || !agent || !host || this.busy || pending.scope !== this.scope) return;
    this.sending = true; this.error = '';
    try {
      const reply = await this.api.webhook(host.domain, agent, pending.mapping.originalQuery, this.context, true, 'trinet-payrun-mock',
        { mappingId: pending.mapping.id, questionId }, pending.requestId) as PayrunReply;
      if (this.pending === pending) this.pending = null;
      this.renderReply(reply, agent, pending.scope);
    } catch (error) { if (pending.scope === this.scope) this.error = errorMessage(error); }
    finally { this.sending = false; this.scrollPending = true; }
  }
  closeLibrary(): void { this.libraryOpen = false; this.librarySearch = ''; }
  @HostListener('document:mousedown', ['$event']) outside(event: MouseEvent): void {
    if (this.libraryOpen && !this.libraryElement?.nativeElement.contains(event.target as Node)
      && !this.browseButton?.nativeElement.contains(event.target as Node)) this.closeLibrary();
  }
  @HostListener('document:keydown.escape') escape(): void { if (this.libraryOpen) this.closeLibrary(); else this.emit('close'); }
  ngAfterViewChecked(): void {
    if (this.scrollPending && this.thread) { const el = this.thread.nativeElement; el.scrollTop = el.scrollHeight; this.scrollPending = false; }
  }
  private append(...items: ConversationMessage[]): void { this.messages.push(...items); this.scrollPending = true; }
  async ask(text: string): Promise<void> {
    const question = text.trim(), agent = this.agent, host = this.host, scope = this.scope;
    if (!question || !agent || !host || this.busy || this.pending) return;
    this.closeLibrary(); this.error = ''; this.sending = true; this.question = '';
    const messageId = requestId();
    this.append({ id: messageId, role: 'user', text: question, scope });
    try {
      const reply = await this.api.webhook(host.domain, agent, question, this.context, true, 'trinet-payrun-mock') as PayrunReply;
      if (reply.status === 'confirmation_required' && reply.questionMapping) {
        if (scope === this.scope) this.pending = { mapping: reply.questionMapping, scope, messageId, requestId: requestId() };
      } else this.renderReply(reply, agent, scope);
    } catch (error) { if (scope === this.scope) { this.error = errorMessage(error); this.question = question; } }
    finally { this.sending = false; this.scrollPending = true; }
  }
  private renderReply(reply: PayrunReply, agent: Agent, scope: string): void {
      this.append({ id: requestId(), role: 'agent', text: reply.reply, scope, agent: agent.name, mappedQuestion: reply.mappedQuestion?.text,
        modelStatus: reply.analysis?.modelStatus, sources: reply.retrieval?.sources, source: answerSource(reply),
        interactionId: reply.interactionId, rating: '', suggested: reply.incidentAlert?.review ? reply.incidentAlert.suggested : [],
        alreadyRaised: reply.incidentAlert?.review && !reply.incidentAlert.raised ? reply.incidentAlert.alreadyRaised : 0,
        alertNote: reply.incidentAlert?.note });
      const raised = reply.incidentAlert?.raised;
      if (raised) this.append(
        { id: requestId(), role: 'handoff', scope, text: `${raised.findings.length} critical findings: ${agent.name} raised an incident automatically with ${raised.agent.name}.` },
        { id: requestId(), role: 'incident', scope, text: raised.reply, agent: raised.agent.name, incident: raised.incident });
  }
  async handOff(): Promise<void> {
    const agent = this.agent, incidentAgent = this.incidentAgent, host = this.host, scope = this.scope;
    if (!agent || !incidentAgent || !host || this.busy || this.pending) return;
    this.error = ''; this.handingOff = true;
    const conversation = this.visibleMessages.filter(item => item.role === 'user' || item.role === 'agent')
      .map(item => ({ role: item.role, agent: item.agent, text: item.text }));
    this.append({ id: requestId(), role: 'handoff', scope, text: `${agent.name} handed this conversation to ${incidentAgent.name}.` });
    try {
      const reply = await this.api.webhook(host.domain, incidentAgent, 'Create an incident report from this conversation.',
        { ...this.context, task: 'incident-report', handoff: { fromAgent: agent.name, conversation } }, true, 'trinet-payrun-mock') as PayrunReply;
      this.append({ id: requestId(), role: 'incident', scope, agent: incidentAgent.name, text: reply.reply, incident: reply.incident });
    } catch (error) { if (scope === this.scope) this.error = errorMessage(error); }
    finally { this.handingOff = false; this.scrollPending = true; }
  }
  async rate(item: ConversationMessage, choice: string): Promise<void> {
    if (!this.host || item.ratingBusy) return;
    const previous = item.rating; item.rating = previous === choice ? '' : choice; item.ratingBusy = true;
    try { await this.api.graphql(RATE_ANSWER_MUTATION, { input: { domainName: this.host.domain.name, interactionId: item.interactionId, rating: item.rating } }); }
    catch (error) { item.rating = previous; this.error = `Feedback not saved: ${errorMessage(error)}`; }
    finally { item.ratingBusy = false; }
  }
}

function answerSource(reply: PayrunReply): ReplySource | undefined {
  if (reply.answeredBy === 'payroll-data') return { kind: 'data', label: 'Computed from payroll data' };
  const seconds = reply.metrics?.latencyMs != null ? ` · ${(reply.metrics.latencyMs / 1000).toFixed(1)} s` : '';
  if (reply.answeredBy === 'rag' || reply.answeredBy === 'anomaly-pipeline') {
    const basis = reply.answeredBy === 'rag' ? 'Payroll history search' : 'Calculated history comparison';
    return { kind: 'data', label: basis + (reply.analysis?.modelStatus === 'completed' && reply.model ? ` · explained by ${reply.model.name}${seconds}` : '') };
  }
  if (reply.answeredBy === 'model' && reply.model) return { kind: 'model', label: `Written by ${reply.model.name}${reply.cached ? ' · repeated answer' : seconds}`,
    checked: reply.check?.checked ? reply.check.ok : undefined };
  return undefined;
}
