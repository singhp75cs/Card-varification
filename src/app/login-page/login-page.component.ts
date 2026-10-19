import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './login-page.component.html',
  styleUrls: ['./login-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class LoginPageComponent implements OnInit {
  email = '';
  password = '';
  success = '';
  error = '';

  constructor(private auth: AuthService, private router: Router) {}

  ngOnInit(): void {}

  onSubmit(): void {
    this.success = '';
    this.error = '';

    this.auth.login(this.email, this.password).subscribe({
      next: () => {
        this.success = 'Login successful';
        this.router.navigate([this.auth.homeRoute()]);
      },
      error: (err) => {
        this.error = err.message || 'Login failed';
      }
    });
  }
}
