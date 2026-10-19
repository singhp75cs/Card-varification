import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CaseService, Document } from '../../services/case.service';
import { UploadService } from '../../services/upload.service';

/** Upload + list documents (image/PDF) with a document_type picker. */
@Component({
  selector: 'app-document-upload',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './document-upload.component.html',
  styleUrls: ['./document-upload.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DocumentUploadComponent {
  @Input() caseRef = '';
  @Input() documents: Document[] = [];
  @Input() editable = true;
  @Input() analyzing = false;
  @Output() documentsChange = new EventEmitter<Document[]>();
  @Output() analyze = new EventEmitter<void>();

  readonly documentTypes = [
    'Aadhaar Card',
    'PAN Card',
    'Insurance Card',
    'Driving License',
    'Passport',
    'Voter ID',
    'Other',
  ];
  documentType = 'Aadhaar Card';
  uploading = false;
  error = '';

  constructor(private uploads: UploadService, private cases: CaseService) {}

  get safeDocuments(): Document[] {
    return Array.isArray(this.documents) ? this.documents : [];
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file || !this.caseRef) return;

    this.uploading = true;
    this.error = '';
    this.uploads.uploadDocument(file).subscribe({
      next: (res) => {
        this.cases
          .attachDocument(this.caseRef, {
            url: res.url,
            originalName: res.originalName,
            documentType: this.documentType,
            contentType: res.contentType,
          })
          .subscribe({
            next: (doc) => {
              this.documents = [...this.safeDocuments, doc];
              this.documentsChange.emit(this.documents);
              this.uploading = false;
              input.value = '';
            },
            error: (err) => {
              this.error = err?.error?.detail || 'Failed to attach document';
              this.uploading = false;
            },
          });
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Upload failed';
        this.uploading = false;
      },
    });
  }

  removeDocument(doc: Document): void {
    if (!this.caseRef) return;
    this.cases.deleteDocument(this.caseRef, doc.id).subscribe({
      next: () => {
        this.documents = this.safeDocuments.filter(d => d.id !== doc.id);
        this.documentsChange.emit(this.documents);
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to remove document';
      },
    });
  }
}
