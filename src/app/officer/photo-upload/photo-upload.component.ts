import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { CaseService, Photo } from '../../services/case.service';
import { UploadService } from '../../services/upload.service';

/** Upload + list site photos for a case. */
@Component({
  selector: 'app-photo-upload',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './photo-upload.component.html',
  styleUrls: ['./photo-upload.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PhotoUploadComponent {
  @Input() caseRef = '';
  @Input() photos: Photo[] = [];
  @Input() editable = true;
  @Input() analyzing = false;
  @Output() photosChange = new EventEmitter<Photo[]>();
  @Output() analyze = new EventEmitter<void>();

  readonly captions = [
    'Front Side',
    'Back Side',
    'Full Card',
    'Close-up',
    'Photo Page',
    'Selfie with Card',
    'Other',
  ];
  readonly categories = [
    'Aadhaar Card',
    'PAN Card',
    'Insurance Card',
    'Driving License',
    'Passport',
    'Voter ID',
    'Other',
  ];
  caption = 'Front Side';
  category = 'Aadhaar Card';
  uploading = false;
  error = '';

  constructor(private uploads: UploadService, private cases: CaseService) {}

  get safePhotos(): Photo[] {
    return Array.isArray(this.photos) ? this.photos : [];
  }

  absUrl(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
    const normalized = url.replace(/^\//, '');
    if (normalized.startsWith('uploads/')) return `${environment.apiUrl}/${normalized}`;
    return normalized;
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file || !this.caseRef) return;

    this.uploading = true;
    this.error = '';
    this.uploads.uploadImage(file).subscribe({
      next: (res) => {
        this.cases
          .attachPhoto(this.caseRef, {
            url: res.url,
            originalName: res.originalName,
            caption: this.caption,
            category: this.category,
          })
          .subscribe({
            next: (photo) => {
              this.photos = [...this.safePhotos, photo];
              this.photosChange.emit(this.photos);
              this.caption = this.captions[0];
              this.category = this.categories[0];
              this.uploading = false;
              input.value = '';
            },
            error: (err) => {
              this.error = err?.error?.detail || 'Failed to attach photo';
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

  removePhoto(photo: Photo): void {
    if (!this.caseRef) return;
    this.cases.deletePhoto(this.caseRef, photo.id).subscribe({
      next: () => {
        this.photos = this.safePhotos.filter(p => p.id !== photo.id);
        this.photosChange.emit(this.photos);
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Failed to remove photo';
      },
    });
  }
}
