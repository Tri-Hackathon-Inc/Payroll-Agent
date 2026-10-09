import { Injectable } from '@angular/core';
import { ApiService } from '../../app/api.service';
import { Agent, Domain } from '../../app/models';

// Both the runtime files and API live under the same public Studio mount. Relative URLs
// also work through a host's reverse proxy, without browser CORS or deployment hostnames.
@Injectable()
export class PayrunApiService extends ApiService {
  override url(path: string): string { return new URL(`../../${path}`, document.baseURI).href; }
  override sessionKey(domain: Domain, agent: Agent, context: Record<string, unknown> = {}): string {
    return `payroll-chat:${JSON.stringify([domain.name, agent.id, context['payrunId'] || '', context['employeeId'] || ''])}`;
  }
}
