import { Component, Input, Output, EventEmitter } from '@angular/core';
import { ApiService } from './api.service';
import { Agent, Domain, errorMessage } from './models';
import { EVALUATION_PAYRUN, EVALUATION_SUITES, gradeReply } from '../evaluationSuites.js';
interface Check { label: string; passed: boolean; }
interface Result { running?: boolean; error?: string; cases: { id: string; prompt: string; reply: string; checks: Check[] }[]; }
@Component({ selector: 'app-evaluation', standalone: true, templateUrl: './evaluation.component.html' })
export class EvaluationComponent {
  @Input() domain!: Domain; @Input() agents: Agent[] = []; @Output() browse = new EventEmitter<void>();
  payrun = EVALUATION_PAYRUN; suites = Object.entries(EVALUATION_SUITES); results: Record<string, Result> = {}; open = '';
  constructor(private api: ApiService) {}
  suite(agent: Agent) { return EVALUATION_SUITES[agent.templateId as keyof typeof EVALUATION_SUITES]; }
  score(result: Result): string { const checks = result.cases.flatMap(c => c.checks); const passed = checks.filter(c => c.passed).length; return checks.length ? `${passed}/${checks.length} · ${Math.round(passed / checks.length * 100)}%` : 'Not run'; }
  async run(agent: Agent): Promise<void> {
    const suite = this.suite(agent); if (!suite || this.results[agent.id]?.running) return;
    const result: Result = { running: true, cases: [] }; this.results[agent.id] = result; this.open = agent.id;
    try { for (const item of suite.cases) { const { reply } = await this.api.webhook(this.domain, agent, item.prompt, { page: 'payrun', payrunId: this.payrun, evaluation: item.id }, false, 'agent-studio-evaluation'); result.cases.push({ id: item.id, prompt: item.prompt, reply, checks: gradeReply(reply, item.checks) }); } }
    catch (error) { result.error = errorMessage(error); } finally { result.running = false; }
  }
}
