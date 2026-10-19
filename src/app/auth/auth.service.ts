import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';

/** Backend TokenResponse shape (snake_case). */
interface TokenResponse {
  access_token: string;
  user_name: string;
  user_role: string;
  user_id: number;
}

export interface AuthResult {
  token: string;
  name: string;
  role: string;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  constructor(private http: HttpClient) {}

  login(email: string, password: string): Observable<AuthResult> {
    // Authenticate against the real backend and store the real JWT + role.
    // No mock/offline fallback: a bad credential or an unreachable backend must
    // surface a real error rather than silently storing a fake token that the
    // API would later reject with 401.
    return this.http
      .post<TokenResponse>(`${environment.apiUrl}/auth/login`, { email, password })
      .pipe(
        map(res => this.storeSession(res.access_token, res.user_name, res.user_role))
      );
  }

  register(name: string, email: string, password: string, role: string): Observable<AuthResult> {
    return this.http
      .post<TokenResponse>(`${environment.apiUrl}/auth/register`, {
        name,
        email,
        password,
        role,
      })
      .pipe(
        map(res => this.storeSession(res.access_token, res.user_name, res.user_role))
      );
  }

  private storeSession(token: string, name: string, role: string): AuthResult {
    const safeRole = role || 'field_officer';
    localStorage.setItem('token', token);
    localStorage.setItem('username', name);
    localStorage.setItem('role', safeRole);
    return { token, name, role: safeRole };
  }

  logout(): void {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
  }

  isAuthenticated(): boolean {
    return !!localStorage.getItem('token');
  }

  getUsername(): string | null {
    return localStorage.getItem('username');
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  getRole(): string | null {
    return localStorage.getItem('role');
  }

  /** Where to send a user after login, based on their role. */
  homeRoute(): string {
    const role = this.getRole();
    if (role) return '/office/overview';
    return '/login';
  }
}
