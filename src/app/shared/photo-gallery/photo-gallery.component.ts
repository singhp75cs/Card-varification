import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { environment } from '../../../environments/environment';
import { Photo } from '../../services/case.service';

/** Read-only photo gallery; tolerates empty arrays (NFR-3). */
@Component({
  selector: 'app-photo-gallery',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './photo-gallery.component.html',
  styleUrls: ['./photo-gallery.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PhotoGalleryComponent {
  @Input() photos: Photo[] = [];

  get safePhotos(): Photo[] {
    return Array.isArray(this.photos) ? this.photos : [];
  }

  /** Resolve a stored /uploads/<name> URL to an absolute, loadable URL. */
  absUrl(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
    const normalized = url.replace(/^\//, '');
    if (normalized.startsWith('uploads/')) {
      return `${environment.apiUrl}/${normalized}`;
    }
    return normalized;
  }
}
