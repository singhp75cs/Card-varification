import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CaseDetail, CaseService, Document, Photo } from '../../services/case.service';
import { CaseDetailsFormComponent, CaseDetailsModel } from '../case-details-form/case-details-form.component';
import { PhotoUploadComponent } from '../photo-upload/photo-upload.component';
import { DocumentUploadComponent } from '../document-upload/document-upload.component';
import { GpsCaptureComponent } from '../gps-capture/gps-capture.component';
import { AiResultsViewComponent } from '../../shared/ai-results-view/ai-results-view.component';

/** Create / edit / resubmit a verification case. */
@Component({
  selector: 'app-officer-case-form',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CaseDetailsFormComponent,
    PhotoUploadComponent,
    DocumentUploadComponent,
    GpsCaptureComponent,
    AiResultsViewComponent,
  ],
  templateUrl: './officer-case-form.component.html',
  styleUrls: ['./officer-case-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OfficerCaseFormComponent implements OnInit {
  caseRef = '';
  detail: CaseDetail | null = null;

  details: CaseDetailsModel = {
    customerName: '',
    siteAddress: '',
    siteId: '',
    contact: '',
    verificationType: '',
    notes: '',
  };
  photos: Photo[] = [];
  documents: Document[] = [];

  saving = false;
  analyzing = false;
  cardNumberValid = true;
  error = '';
  info = '';

  constructor(
    private cases: CaseService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    const ref = this.route.snapshot.paramMap.get('ref');
    if (ref && ref !== 'new') {
      this.caseRef = ref;
      this.load();
    }
  }

  get isNew(): boolean {
    return !this.caseRef;
  }

  get status(): string {
    return this.detail?.status ?? 'Draft';
  }

  get editable(): boolean {
    return this.status === 'Draft' || this.status === 'Needs Correction';
  }

  get needsCorrection(): boolean {
    return this.status === 'Needs Correction';
  }

  get submitLabel(): string {
    return this.needsCorrection ? 'Resubmit' : 'Submit';
  }

  private load(): void {
    this.cases.get(this.caseRef).subscribe({
      next: (d) => this.applyDetail(d),
      error: (err) => (this.error = err?.error?.detail || 'Failed to load case'),
    });
  }

  private applyDetail(d: CaseDetail): void {
    this.detail = d;
    this.details = {
      customerName: d.customerName,
      siteAddress: d.siteAddress,
      siteId: d.siteId,
      contact: d.contact,
      verificationType: d.verificationType,
      notes: d.notes,
    };
    this.photos = d.photos;
    this.documents = d.documents;
  }

  saveDetails(): void {
    this.error = '';
    this.info = '';
    if (!this.details.customerName.trim() || !this.details.siteAddress.trim()) {
      this.error = 'Applicant name and address are required.';
      return;
    }
    if (!this.cardNumberValid) {
      this.error = 'The card / reference number does not match the selected card type format.';
      return;
    }
    this.saving = true;
    if (this.isNew) {
      this.cases.create(this.details).subscribe({
        next: (d) => {
          this.caseRef = d.caseRef;
          this.applyDetail(d);
          this.info = `Case ${d.caseRef} created.`;
          this.saving = false;
          this.router.navigate(['/officer/cases', d.caseRef]);
        },
        error: (err) => {
          this.error = err?.error?.detail || 'Failed to create case';
          this.saving = false;
        },
      });
    } else {
      this.cases.update(this.caseRef, this.details).subscribe({
        next: (d) => {
          this.applyDetail(d);
          this.info = 'Details saved.';
          this.saving = false;
        },
        error: (err) => {
          this.error = err?.error?.detail || 'Failed to save details';
          this.saving = false;
        },
      });
    }
  }

  submit(): void {
    this.error = '';
    this.info = '';
    if (!this.caseRef) {
      this.error = 'Save the case before submitting.';
      return;
    }
    this.saving = true;
    this.cases.submit(this.caseRef).subscribe({
      next: (d) => {
        this.applyDetail(d);
        this.info = `Case submitted (${d.status}).`;
        this.saving = false;
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to submit case';
        this.saving = false;
      },
    });
  }

  analyze(): void {
    this.error = '';
    this.info = '';
    if (!this.caseRef) {
      this.error = 'Save the case before analyzing.';
      return;
    }
    if (!this.photos.length) {
      this.error = 'Attach at least one photo before analyzing.';
      return;
    }
    this.analyzing = true;
    this.cases.analyze(this.caseRef).subscribe({
      next: (d) => {
        this.applyDetail(d);
        this.info = `AI analysis complete (${d.aiResults.length} result(s)).`;
        this.analyzing = false;
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to analyze images';
        this.analyzing = false;
      },
    });
  }

  back(): void {
    this.router.navigate(['/officer/cases']);
  }
}
