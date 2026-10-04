import { Component, Input } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { Incident, Screenshot } from './models';

@Component({ selector: 'agent-incident', standalone: true, imports: [CurrencyPipe], templateUrl: './incident.component.html' })
export class IncidentComponent {
  @Input({ required: true }) incident!: Incident;
  @Input() agentName = '';
  showReport = false;
  viewing: (Screenshot & { title: string }) | null = null;
  get report(): string { return this.incident.report.replace(/\(data:image\/[^)]+\)/g, '(screenshot)'); }
  view(shot: Screenshot, title: string, dialog: HTMLDialogElement): void { this.viewing = { ...shot, title }; dialog.showModal(); }
  close(dialog: HTMLDialogElement): void { dialog.close(); this.viewing = null; }
  download(): void {
    const url = URL.createObjectURL(new Blob([this.incident.report], { type: 'text/markdown' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `${this.incident.id}.md` });
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
