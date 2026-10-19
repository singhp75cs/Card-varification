import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { NavigationEnd, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from './auth/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  // Mutates username on every NavigationEnd — keep Eager so the view always updates
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class AppComponent implements OnInit {
  title = 'Card Verification';
  username: string | null = '';

  constructor(
    public auth: AuthService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.username = this.auth.getUsername();

    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        this.username = this.auth.getUsername();
      }
    });
  }

  goHome(): void {
    this.router.navigate([this.auth.homeRoute()]);
  }

  get isLoggedIn(): boolean {
    return this.auth.isAuthenticated();
  }

  get role(): string | null {
    return this.auth.getRole();
  }

  get isFieldOfficer(): boolean {
    return this.role === 'field_officer' || this.role === 'admin';
  }

  get isFrontOffice(): boolean {
    return this.role === 'front_office' || this.role === 'admin';
  }

  updateUsername(): void {
    this.username = this.auth.getUsername();
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  ngDoCheck(): void {
    this.username = this.auth.getUsername();
  }
}
