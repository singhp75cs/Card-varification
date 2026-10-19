import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

/** Raw case shape returned by the FastAPI backend. */
interface BackendCase {
  case_ref: string;
  status: string;
  created_at: string;
}

/** Shape the chart component consumes (reads .date and .status). */
export interface ChartCase {
  caseRef: string;
  status: string;
  date: string;
}

@Injectable({
  providedIn: 'root',
})
export class StatusChartService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient, private auth: AuthService) {}

  private authHeaders(): HttpHeaders {
    const token = this.auth.getToken();
    return new HttpHeaders(token ? { Authorization: 'Bearer ' + token } : {});
  }

  /**
   * Live cases for the chart. Maps backend fields to the shape the chart reads:
   *   created_at -> date
   *   status     -> status
   */
  getCases(): Observable<ChartCase[]> {
    return this.http
      .get<BackendCase[]>(`${this.apiUrl}/cases`, { headers: this.authHeaders() })
      .pipe(
        map(list =>
          Array.isArray(list)
            ? list.map(c => ({
                caseRef: c?.case_ref ?? '',
                status: c?.status ?? '',
                date: c?.created_at ?? '',
              }))
            : []
        )
      );
  }
}
