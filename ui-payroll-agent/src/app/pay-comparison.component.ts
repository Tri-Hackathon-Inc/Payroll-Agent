import { Component, Input } from '@angular/core';
import { PayComparison, PayComparisonRow, PayPeriod } from './pay-comparison.models';

@Component({ selector: 'app-pay-comparison', standalone: true,
  templateUrl: './pay-comparison.component.html', styleUrl: './pay-comparison.component.css' })
export class PayComparisonComponent {
  @Input({ required: true }) comparison!: PayComparison;
  @Input() explanation = '';
  @Input() fullReply = '';
  @Input() modelMessage = '';
  readonly periods = ['previous', 'current'] as const;
  money(value: number | null): string {
    if (value === null) return 'Unavailable';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: this.comparison.currency }).format(value);
  }
  amount(row: PayComparisonRow, side: 'previous' | 'current'): string {
    const amount = row[side];
    return this.money(amount !== null && row.kind === 'withholding' && amount !== 0 ? -amount : amount);
  }
  dates(period: PayPeriod | null): string {
    if (!period) return 'No comparable payrun';
    const date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${date(period.periodStart)} – ${date(period.periodEnd)}`;
  }
  delta(row: PayComparisonRow): string {
    return row.delta === null ? '' : `${row.delta > 0 ? '↑' : '↓'} ${this.money(Math.abs(row.delta))}`;
  }
  favorable(row: PayComparisonRow): boolean {
    return row.delta !== null && (row.kind === 'withholding' ? row.delta < 0 : row.delta > 0);
  }
  get headline(): string {
    const delta = this.comparison.netChange;
    if (!this.comparison.previous) return 'Your current paycheck';
    if (delta === null) return 'The net pay difference is unavailable';
    if (delta === 0) return 'Your net pay is unchanged';
    return `Your net pay is ${this.money(Math.abs(delta))} ${delta < 0 ? 'lower' : 'higher'}`;
  }
}
