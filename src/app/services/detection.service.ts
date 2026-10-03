import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

export interface DetectionBox {
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YoloResult {
  image_url: string;
  detections: DetectionBox[];
  saved_path: string;
}

@Injectable({
  providedIn: 'root'
})
export class DetectionService {
  constructor(private http: HttpClient, private auth: AuthService) {}

  detectImage(file: Blob | File, orderId?: string): Observable<YoloResult> {
    const formData = new FormData();
    // Append with a filename so a bare Blob still has a name on the backend.
    formData.append('file', file, 'image.jpg');
    if (orderId) {
      formData.append('order_id', orderId);
    }

    const token = this.auth.getToken();
    // Do NOT set Content-Type — the browser sets the multipart boundary.
    const headers = new HttpHeaders(
      token ? { Authorization: 'Bearer ' + token } : {}
    );

    return this.http.post<YoloResult>(
      `${environment.apiUrl}/detect`,
      formData,
      { headers }
    );
  }
}
