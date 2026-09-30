export interface PayPeriod { payrunId: string; periodStart: string; periodEnd: string; payDate: string; }
export interface PayComparisonRow {
  key: string; label: string; kind: 'earning' | 'withholding' | 'net';
  previous: number | null; current: number | null; delta: number | null;
}
export interface PayComparison {
  employeeId: string; employeeName: string; currency: string;
  previous: PayPeriod | null; current: PayPeriod; rows: PayComparisonRow[];
  overtime: { previous: number | null; current: number | null; previousHours: number | null; currentHours: number | null };
  netChange: number | null; reconciled: boolean;
}
export interface PayrollAnalysis {
  modelStatus?: string; modelMessage?: string | null; details?: string; payComparison?: PayComparison | null;
  modelAnswer?: { summary: string } | null;
}
