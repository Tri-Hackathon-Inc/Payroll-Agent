import { Injectable } from '@angular/core';
import { Agent, Domain, WebhookReply, QuestionConfirmation } from './models';

export class ApiError extends Error { constructor(message: string, public code?: string) { super(message); } }
export const requestId = (): string => globalThis.crypto.randomUUID?.()
  ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

@Injectable({ providedIn: 'root' })
export class ApiService {
  url(path: string): string { return new URL(path, document.baseURI).href; }
  async graphql<T>(query: string, variables: object = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.url('graphql'), { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const payload = await response.json().catch(() => ({}));
    if (payload.errors?.length) throw new ApiError(payload.errors[0].message, payload.errors[0].extensions?.code);
    if (!response.ok) throw new ApiError(`Request failed (${response.status}).`);
    if (!payload.data) throw new ApiError('The server did not return GraphQL data.');
    return payload.data as T;
  }
  async access(path: string, body: object = {}): Promise<void> {
    const response = await fetch(this.url(`auth/${path}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload.message || `Sign-in failed (${response.status}).`);
  }
  sessionKey(domain: Domain, agent: Agent, context: Record<string, unknown> = {}): string {
    return `studio-webhook:${JSON.stringify([domain.name, agent.id, context['page'], context['payrunId'], context['employeeId']])}`;
  }
  stored(key: string): string | undefined { try { return sessionStorage.getItem(key) || undefined; } catch { return undefined; } }
  store(key: string, id?: string): void { try { if (id) sessionStorage.setItem(key, id); else sessionStorage.removeItem(key); } catch { /* Storage is optional. */ } }
  async webhook(domain: Domain, agent: Agent, question: string, context?: Record<string, unknown>, conversation = false, source = 'agent-studio-chat', confirmation?: QuestionConfirmation, submissionId = requestId()): Promise<WebhookReply> {
    const key = this.sessionKey(domain, agent, context);
    const response = await fetch(this.url(`webhook/${encodeURIComponent(domain.name)}/${encodeURIComponent(agent.id)}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, context, source, confirmation,
        ...(conversation ? { sessionId: this.stored(key), requestId: submissionId } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.message || `Webhook request failed (${response.status}).`);
    if (conversation && body.session?.id) this.store(key, body.session.id);
    return { ...body, reply: body.reply || body.message || body.answer || 'Your request was sent to the agent webhook.' };
  }
  trinet(domain?: string): string {
    const host = document.querySelector<HTMLMetaElement>('meta[name="trinet-url"]')?.content || 'http://localhost:5174/trinet/';
    const url = new URL(host, location.origin);
    if (domain) url.searchParams.set('domain', domain);
    return url.href;
  }
}
