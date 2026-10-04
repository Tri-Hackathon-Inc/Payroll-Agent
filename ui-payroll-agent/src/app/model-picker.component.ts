import { Component, Input, Output, EventEmitter } from '@angular/core';
import { Model } from './models';

@Component({ selector: 'app-model-picker', standalone: true, templateUrl: './model-picker.component.html' })
export class ModelPickerComponent {
  @Input() models: Model[] = [];
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();
  get options(): Model[] { return this.models.some(m => m.id === this.value) ? this.models : [...this.models, { id: this.value, name: `${this.value} (saved selection)`, provider: '', details: {} }]; }
  sources(model: Model): string[] { return [...new Set((model.details.benchmarks || []).map(b => b.source))]; }
}
