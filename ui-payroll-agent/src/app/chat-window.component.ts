import { Component, Input, OnInit, HostListener, ViewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Agent, Domain, errorMessage } from './models';
import { DOMAINS_QUERY, SERVICE_AGENT_REGISTRY_QUERY } from '../graphql/operations.js';
@Component({ selector: 'app-chat-window', standalone: true, imports: [FormsModule], templateUrl: './chat-window.component.html' })
export class ChatWindowComponent implements OnInit {
  @Input() domainName = '';
  @ViewChild('composer') composer?: ElementRef<HTMLInputElement>;
  @ViewChild('picker') picker?: ElementRef<HTMLDivElement>;
  domains: Domain[] = []; domain: Domain | null = null; agents: Agent[] = []; selected: Agent | null = null;
  messages: { role: string; text: string; agent: Agent }[] = []; message = ''; error = ''; pickerError = ''; pickerOpen = false; stage = 'domains'; loading = false; sending = false;
  constructor(private api: ApiService) {}
  async ngOnInit(): Promise<void> { if (this.domainName) { await this.loadDomains(); const domain = this.domains.find(d => d.name === this.domainName); if (domain) await this.loadAgents(domain); } }
  @HostListener('document:mousedown', ['$event']) outside(event: MouseEvent): void { if (this.picker && !this.picker.nativeElement.contains(event.target as Node) && event.target !== this.composer?.nativeElement) this.pickerOpen = false; }
  async loadDomains(): Promise<void> { this.loading = true; this.pickerError = ''; try { this.domains = (await this.api.graphql<{ listDomains: Domain[] }>(DOMAINS_QUERY)).listDomains; } catch (error) { this.pickerError = errorMessage(error); } finally { this.loading = false; } }
  async loadAgents(domain: Domain): Promise<void> {
    this.domain = domain; this.selected = null; this.stage = 'agents'; this.loading = true; this.pickerError = '';
    try { this.agents = (await this.api.graphql<{ getServiceAgentRegistry: Agent[] }>(SERVICE_AGENT_REGISTRY_QUERY, { domainName: domain.name })).getServiceAgentRegistry; }
    catch (error) { this.pickerError = errorMessage(error); this.agents = []; } finally { this.loading = false; }
  }
  async openPicker(): Promise<void> { if (this.sending) return; this.pickerOpen = true; this.stage = this.domain ? 'agents' : 'domains'; if (!this.domains.length) await this.loadDomains(); }
  select(agent: Agent): void { this.selected = agent; this.pickerOpen = false; this.message = this.message.replace(/@$/, ''); this.composer?.nativeElement.focus(); }
  typed(value: string): void { this.message = value; if (value.endsWith('@')) void this.openPicker(); }
  initials(agent: Agent): string { return agent.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(); }
  newChat(): void { if (this.domain && this.selected) this.api.store(this.api.sessionKey(this.domain, this.selected)); this.messages = []; this.error = ''; }
  async send(): Promise<void> {
    if (!this.message.trim() || !this.selected || !this.domain || this.sending) return;
    const question = this.message.trim(), agent = this.selected; this.message = ''; this.error = ''; this.sending = true; this.messages.push({ role: 'user', text: question, agent });
    try { const reply = await this.api.webhook(this.domain, agent, question, undefined, true); this.messages.push({ role: 'agent', text: reply.reply, agent }); }
    catch (error) { this.error = errorMessage(error); this.message = question; } finally { this.sending = false; }
  }
}
