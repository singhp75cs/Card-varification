import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './auth/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () =>
      import('./login-page/login-page.component').then(m => m.LoginPageComponent),
  },
  {
    path: 'signup',
    loadComponent: () =>
      import('./signup/signup.component').then(m => m.SignupComponent),
  },

  // ── Field Officer ──────────────────────────────────────────────────────
  {
    path: 'officer/cases',
    loadComponent: () =>
      import('./officer/officer-case-list/officer-case-list.component').then(
        m => m.OfficerCaseListComponent
      ),
    canActivate: [authGuard, roleGuard(['field_officer', 'admin'])],
  },
  {
    path: 'officer/cases/new',
    loadComponent: () =>
      import('./officer/officer-case-form/officer-case-form.component').then(
        m => m.OfficerCaseFormComponent
      ),
    canActivate: [authGuard, roleGuard(['field_officer', 'admin'])],
  },
  {
    path: 'officer/cases/:ref',
    loadComponent: () =>
      import('./officer/officer-case-form/officer-case-form.component').then(
        m => m.OfficerCaseFormComponent
      ),
    canActivate: [authGuard, roleGuard(['field_officer', 'admin'])],
  },

  // ── Front Office ───────────────────────────────────────────────────────
  {
    path: 'office/review',
    loadComponent: () =>
      import('./office/review-queue/review-queue.component').then(
        m => m.ReviewQueueComponent
      ),
    canActivate: [authGuard, roleGuard(['front_office', 'admin'])],
  },
  {
    path: 'office/review/:ref',
    loadComponent: () =>
      import('./office/case-review/case-review.component').then(
        m => m.CaseReviewComponent
      ),
    canActivate: [authGuard, roleGuard(['front_office', 'admin'])],
  },
  {
    path: 'office/completed',
    loadComponent: () =>
      import('./office/completed-cases/completed-cases.component').then(
        m => m.CompletedCasesComponent
      ),
    canActivate: [authGuard, roleGuard(['front_office', 'admin'])],
  },
  {
    path: 'office/overview',
    loadComponent: () =>
      import('./office/overview/overview.component').then(m => m.OverviewComponent),
    canActivate: [authGuard, roleGuard(['field_officer', 'front_office', 'admin'])],
  },

  { path: '**', redirectTo: '/login' },
];
