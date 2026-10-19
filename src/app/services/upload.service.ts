import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

/** Result of an upload, with the stored URL resolved to an absolute URL. */
export interface UploadResult {
  url: string;          // absolute URL (apiUrl + stored path)
  originalName: string;
  contentType: string;
  size: number;
}

interface BackendUploadResult {
  filename: string;
  original_name: string;
  url: string;
  size: number;
  content_type: string;
}

@Injectable({ providedIn: 'root' })
export class UploadService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient, private auth: AuthService) {}

  private authHeaders(): HttpHeaders {
    const token = this.auth.getToken();
    return new HttpHeaders(token ? { Authorization: 'Bearer ' + token } : {});
  }

  private absUrl(url: string): string {
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : `${this.apiUrl}${url}`;
  }

  private toResult(res: BackendUploadResult): UploadResult {
    return {
      url: this.absUrl(res?.url ?? ''),
      originalName: res?.original_name ?? '',
      contentType: res?.content_type ?? '',
      size: res?.size ?? 0,
    };
  }

  /** Upload a single image → POST /uploads/single. */
  uploadImage(file: File): Observable<UploadResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http
      .post<BackendUploadResult>(`${this.apiUrl}/uploads/single`, form, {
        headers: this.authHeaders(),
      })
      .pipe(map(res => this.toResult(res)));
  }

  /** Upload a single document (image or PDF) → POST /uploads/document. */
  uploadDocument(file: File): Observable<UploadResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http
      .post<BackendUploadResult>(`${this.apiUrl}/uploads/document`, form, {
        headers: this.authHeaders(),
      })
      .pipe(map(res => this.toResult(res)));
  }
}
