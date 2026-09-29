import { Component, Input, Output, EventEmitter, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, requestId } from './api.service';
import { Agent, Domain, Message, ChatReply, errorMessage } from './models';
import { CHAT_AGENT_MUTATION } from '../graphql/operations.js';

@Component({ selector: 'app-agent-chat', standalone: true, imports: [FormsModule], templateUrl: './agent-chat.component.html' })
export class AgentChatComponent implements OnChanges {
  @Input({ required: true }) agent!: Agent;
  @Input({ required: true }) domain!: Domain;
  @Output() back = new EventEmitter<void>();
  messages: Message[] = []; input = ''; error = ''; sending = false; payrunId = ''; employeeId = '';
  constructor(private api: ApiService) {}
  ngOnChanges(): void { this.messages = []; this.input = ''; this.error = ''; this.payrunId = ''; this.employeeId = ''; }
  get sessionKey(): string { return `studio-chat:${JSON.stringify([this.domain.name, this.agent.id, this.payrunId.trim(), this.employeeId.trim()])}`; }
  newChat(): void { this.api.store(this.sessionKey); this.messages = []; this.error = ''; }
  contextChanged(): void { this.messages = []; this.error = ''; if (!this.payrunId.trim()) this.employeeId = ''; }
  async send(): Promise<void> {
    if (this.sending || !this.input.trim()) return;
    this.sending = true; this.error = '';
    const message = this.input.trim(), key = this.sessionKey;
    try {
      const sessionId = this.api.stored(key);
      const { chatAgent } = await this.api.graphql<{ chatAgent: ChatReply }>(CHAT_AGENT_MUTATION, { input: {
        agentId: this.agent.id, domainName: this.domain.name, message, history: sessionId ? [] : this.messages.slice(-40), sessionId, requestId: requestId(),
        context: this.payrunId.trim() ? { page: 'payrun', payrunId: this.payrunId.trim(), employeeId: this.employeeId.trim() || null } : {},
      } });
      if (chatAgent.session?.id) this.api.store(key, chatAgent.session.id);
      this.messages.push({ role: 'user', content: message }, { role: 'assistant', content: chatAgent.output }); this.input = '';
    } catch (error) { this.error = errorMessage(error); } finally { this.sending = false; }
  }
}
