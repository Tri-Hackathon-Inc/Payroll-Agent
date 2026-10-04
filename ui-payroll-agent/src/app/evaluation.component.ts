import { Component, Input, Output, EventEmitter, OnDestroy } from '@angular/core';
import { ApiService, requestId } from './api.service';
import { Agent, Domain, QuestionMapping, errorMessage } from './models';
import { QuestionConfirmationComponent } from './question-confirmation.component';
import { EVALUATION_PAYRUN, EVALUATION_SUITES, gradeReply } from '../evaluationSuites.js';
interface Check { label: string; passed: boolean; }
interface Result { running?: boolean; error?: string; mapping?: QuestionMapping; decide?: (id: string | null) => void; cases: { id: string; prompt: string; reply: string; checks: Check[] }[]; }
@Component({ selector: 'app-evaluation', standalone: true, imports: [QuestionConfirmationComponent], templateUrl: './evaluation.component.html' })
export class EvaluationComponent implements OnDestroy {
  @Input() domain!: Domain; @Input() agents: Agent[] = []; @Output() browse = new EventEmitter<void>();
  payrun = EVALUATION_PAYRUN; suites = Object.entries(EVALUATION_SUITES); results: Record<string, Result> = {}; open = '';
  constructor(private api: ApiService) {}
  private destroyed = false;
  ngOnDestroy(): void { this.destroyed = true; for (const result of Object.values(this.results)) result.decide?.(null); }
  suite(agent: Agent) { return EVALUATION_SUITES[agent.templateId as keyof typeof EVALUATION_SUITES]; }
  score(result: Result): string { const checks = result.cases.flatMap(c => c.checks); const passed = checks.filter(c => c.passed).length; return checks.length ? `${passed}/${checks.length} · ${Math.round(passed / checks.length * 100)}%` : 'Not run'; }
  async run(agent: Agent): Promise<void> {
    const suite = this.suite(agent); if (!suite || this.results[agent.id]?.running) return;
    const result: Result = { running: true, cases: [] }; this.results[agent.id] = result; this.open = agent.id;
    try { for (const item of suite.cases) {
      if (this.destroyed) break;
      const context = { page: 'payrun', payrunId: this.payrun, evaluation: item.id };
      // Each case starts a fresh conversation so a prior evaluation cannot alter its scope.
      this.api.store(this.api.sessionKey(this.domain, agent, context));
      let response = await this.api.webhook(this.domain, agent, item.prompt, context, true, 'agent-studio-evaluation');
      if (this.destroyed) break;
      if (response.status === 'confirmation_required' && response.questionMapping) {
        result.mapping = response.questionMapping;
        const id = await new Promise<string | null>(resolve => { result.decide = resolve; });
        const mapping = result.mapping; result.mapping = undefined; result.decide = undefined;
        if (!id || this.destroyed) break;
        response = await this.api.webhook(this.domain, agent, item.prompt, context, true, 'agent-studio-evaluation',
          { mappingId: mapping.id, questionId: id }, requestId());
      }
      result.cases.push({ id: item.id, prompt: item.prompt, reply: response.reply, checks: gradeReply(response.reply, item.checks) });
    } }
    catch (error) { result.error = errorMessage(error); } finally { result.running = false; }
  }
}
