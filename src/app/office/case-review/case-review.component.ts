import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { CaseDetail, CaseService } from '../../services/case.service';
import { PhotoGalleryComponent } from '../../shared/photo-gallery/photo-gallery.component';
import { AiResultsViewComponent } from '../../shared/ai-results-view/ai-results-view.component';

type ReviewMode = '' | 'approve' | 'reject' | 'request-correction';

/** Front office read-only review of a submitted case + decision actions. */
@Component({
  selector: 'app-case-review',
  standalone: true,
  imports: [CommonModule, FormsModule, PhotoGalleryComponent, AiResultsViewComponent],
  templateUrl: './case-review.component.html',
  styleUrls: ['./case-review.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class CaseReviewComponent implements OnInit {
  caseRef = '';
  detail: CaseDetail | null = null;

  mode: ReviewMode = '';
  comment = '';
  busy = false;
  error = '';

  constructor(
    private cases: CaseService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.caseRef = this.route.snapshot.paramMap.get('ref') ?? '';
    if (this.caseRef) {
      this.cases.get(this.caseRef).subscribe({
        next: (d) => (this.detail = d),
        error: (err) => (this.error = err?.error?.detail || 'Failed to load case'),
      });
    }
  }

  absUrl(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
    const normalized = url.replace(/^\//, '');
    if (normalized.startsWith('uploads/')) return `${environment.apiUrl}/${normalized}`;
    return normalized;
  }

  openAction(mode: ReviewMode): void {
    this.mode = mode;
    this.comment = '';
    this.error = '';
  }

  cancelAction(): void {
    this.mode = '';
    this.comment = '';
  }

  get commentRequired(): boolean {
    return this.mode === 'reject' || this.mode === 'request-correction';
  }

  confirm(): void {
    if (!this.detail) return;
    if (this.commentRequired && !this.comment.trim()) {
      this.error = 'A comment is required for this action.';
      return;
    }
    this.busy = true;
    this.error = '';
    const ref = this.caseRef;
    const comment = this.comment;

    const done = {
      next: () => this.router.navigate(['/office/review']),
      error: (err: any) => {
        this.error = err?.error?.detail || 'Action failed';
        this.busy = false;
      },
    };

    if (this.mode === 'approve') {
      this.cases.approve(ref, comment).subscribe(done);
    } else if (this.mode === 'reject') {
      this.cases.reject(ref, comment).subscribe(done);
    } else if (this.mode === 'request-correction') {
      this.cases.requestCorrection(ref, comment).subscribe(done);
    }
  }

  back(): void {
    this.router.navigate(['/office/review']);
  }
}
