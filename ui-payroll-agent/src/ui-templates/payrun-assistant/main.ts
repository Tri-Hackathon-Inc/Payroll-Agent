import { bootstrapApplication } from '@angular/platform-browser';
import { provideZoneChangeDetection } from '@angular/core';
import { PayrunAssistantComponent } from './payrun-assistant.component';

bootstrapApplication(PayrunAssistantComponent, { providers: [provideZoneChangeDetection()] }).catch(console.error);
