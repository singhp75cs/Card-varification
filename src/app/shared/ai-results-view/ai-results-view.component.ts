import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { environment } from '../../../environments/environment';
import { AIResult, Document, Photo } from '../../services/case.service';

/**
 * Read-only renderer for AI validation results. Shared between the officer form
 * (after analyze/submit) and the front-office review screen. Null-guards every
 * nested field (NFR-3) and shows "OCR not available" when ocrText is null.
 *
 * When `photos` / `documents` are provided, each result card also shows the
 * actual image it was detected from, so the detection is visible next to its
 * scores.
 */
@Component({
  selector: 'app-ai-results-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ai-results-view.component.html',
  styleUrls: ['./ai-results-view.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class AiResultsViewComponent {
  @Input() results: AIResult[] = [];
  @Input() photos: Photo[] = [];
  @Input() documents: Document[] = [];

  get safeResults(): AIResult[] {
    return Array.isArray(this.results) ? this.results : [];
  }

  /** Resolve the preview image URL for a result (photo, or image document). */
  previewUrl(r: AIResult): string {
    if (r.photoId != null) {
      const p = this.photos.find(x => x.id === r.photoId);
      return p ? this.absUrl(p.url) : '';
    }
    if (r.documentId != null) {
      const d = this.documents.find(x => x.id === r.documentId);
      if (d && (d.contentType || '').startsWith('image/')) return this.absUrl(d.url);
    }
    return '';
  }

  private absUrl(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
    const normalized = url.replace(/^\//, '');
    if (normalized.startsWith('uploads/')) return `${environment.apiUrl}/${normalized}`;
    return normalized;
  }

  scorePercent(score: number | null): string {
    if (score == null) return '—';
    return `${Math.round(score * 100)}%`;
  }

  confidencePercent(conf: number | null): string {
    if (conf == null) return '—';
    return `${Math.round(conf * 100)}%`;
  }
}
