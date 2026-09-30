import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QuestionMapping } from './models';

@Component({ selector: 'app-question-confirmation', standalone: true, imports: [FormsModule], templateUrl: './question-confirmation.component.html' })
export class QuestionConfirmationComponent implements OnChanges {
  @Input({ required: true }) mapping!: QuestionMapping;
  @Input() busy = false;
  @Output() confirm = new EventEmitter<string>();
  @Output() revise = new EventEmitter<void>();
  selected = '';
  ngOnChanges(changes: import('@angular/core').SimpleChanges): void {
    if (changes['mapping']) this.selected = this.mapping.candidates[0]?.id || '';
  }
}
