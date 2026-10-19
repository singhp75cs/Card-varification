import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface CaseDetailsModel {
  customerName: string;      // Applicant Name
  siteAddress: string;       // Address
  siteId: string;            // Card / Reference Number
  contact: string;           // Contact / Mobile
  verificationType: string;  // Card Type
  notes: string;
}

/** Applicant/card detail fields. Disabled unless the case is editable. */
@Component({
  selector: 'app-case-details-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './case-details-form.component.html',
  styleUrls: ['./case-details-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CaseDetailsFormComponent {
  @Input() model: CaseDetailsModel = {
    customerName: '',
    siteAddress: '',
    siteId: '',
    contact: '',
    verificationType: '',
    notes: '',
  };
  @Input() editable = true;
  @Output() modelChange = new EventEmitter<CaseDetailsModel>();
  /** Emits the current validity of the card number so the parent can gate save. */
  @Output() cardNumberValid = new EventEmitter<boolean>();

  readonly cardTypes = [
    'Aadhaar Card',
    'PAN Card',
    'Insurance Card',
    'Driving License',
    'Passport',
    'Voter ID',
    'Other',
  ];

  /** Per-card-type format rules: regex + a human hint + placeholder. */
  private readonly cardRules: Record<string, { pattern: RegExp; hint: string; placeholder: string }> = {
    'Aadhaar Card': {
      pattern: /^\d{4}\s?\d{4}\s?\d{4}$/,
      hint: 'Aadhaar must be 12 digits (e.g. 1234 5678 9012).',
      placeholder: '1234 5678 9012',
    },
    'PAN Card': {
      pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/i,
      hint: 'PAN must be 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).',
      placeholder: 'ABCDE1234F',
    },
    'Passport': {
      pattern: /^[A-Z][0-9]{7}$/i,
      hint: 'Passport must be 1 letter followed by 7 digits (e.g. A1234567).',
      placeholder: 'A1234567',
    },
    'Driving License': {
      pattern: /^[A-Z]{2}[0-9]{2}\s?[0-9]{4}[0-9]{7}$/i,
      hint: 'Driving License format: SS RR YYYY NNNNNNN (e.g. MH12 20231234567).',
      placeholder: 'MH12 20231234567',
    },
    'Voter ID': {
      pattern: /^[A-Z]{3}[0-9]{7}$/i,
      hint: 'Voter ID must be 3 letters followed by 7 digits (e.g. ABC1234567).',
      placeholder: 'ABC1234567',
    },
    'Insurance Card': {
      pattern: /^[A-Za-z0-9\-\/]{6,25}$/,
      hint: 'Insurance/policy number must be 6–25 letters, digits, - or /.',
      placeholder: 'POL-123456789',
    },
    'Other': {
      pattern: /^.{1,50}$/,
      hint: '',
      placeholder: 'Reference number',
    },
  };

  get cardPlaceholder(): string {
    return this.cardRules[this.model.verificationType]?.placeholder ?? 'Reference number';
  }

  get cardHint(): string {
    return this.cardRules[this.model.verificationType]?.hint ?? '';
  }

  /** Returns true when the card number matches the selected card type's format. */
  get cardNumberIsValid(): boolean {
    const value = (this.model.siteId || '').trim();
    const type = this.model.verificationType;
    // No card type chosen or empty number → not blocking here (treated as "not yet validated").
    if (!type || !value) return true;
    const rule = this.cardRules[type];
    if (!rule) return true;
    return rule.pattern.test(value);
  }

  get showCardError(): boolean {
    const value = (this.model.siteId || '').trim();
    return !!this.model.verificationType && !!value && !this.cardNumberIsValid;
  }

  onChange(): void {
    this.modelChange.emit(this.model);
    this.cardNumberValid.emit(this.cardNumberIsValid);
  }
}
