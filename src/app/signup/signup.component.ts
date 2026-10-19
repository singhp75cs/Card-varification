import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../auth/auth.service';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [FormsModule, CommonModule, RouterModule],
  templateUrl: './signup.component.html',
  styleUrls: ['./signup.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SignupComponent {
  name = '';
  email = '';
  password = '';
  role = 'field_officer';
  readonly roles = ['field_officer', 'front_office'];

  message = '';
  error = '';

  constructor(private auth: AuthService, private router: Router) {}

  onRegister(): void {
    this.message = '';
    this.error = '';
    this.auth.register(this.name, this.email, this.password, this.role).subscribe({
      next: () => {
        this.message = 'Registered successfully';
        this.router.navigate([this.auth.homeRoute()]);
      },
      error: (err) => {
        this.error = err?.error?.detail || err?.message || 'Registration failed';
      },
    });
  }
}
