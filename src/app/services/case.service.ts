import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

// ── UI-facing (camelCase) interfaces ─────────────────────────────────────────

export interface Photo {
  id: number;
  caseId: number;
  url: string;
  originalName: string;
  caption: string;
  category: string;
  createdAt: string;
}

export interface Document {
  id: number;
  caseId: number;
  url: string;
  originalName: string;
  documentType: string;
  contentType: string;
  createdAt: string;
}

export interface RequiredObject {
  name: string;
  present: boolean;
}

/** A single YOLO detection with a normalised bounding box (0..1 of image size). */
export interface Detection {
  label: string;
  confidence: number;
  box: { x: number; y: number; w: number; h: number };
}

export interface AIResult {
  id: number;
  caseId: number;
  photoId: number | null;
  documentId: number | null;
  photoQualityScore: number | null;
  photoQualityPass: boolean | null;
  requiredObjects: RequiredObject[] | null;
  requiredObjectsPass: boolean | null;
  documentTypeDetected: string | null;
  documentTypeConfidence: number | null;
  ocrText: string | null;
  extractedFields: Record<string, unknown> | null;
  detections: Detection[];
  note: string;
  createdAt: string;
}

export interface Case {
  id: number;
  caseRef: string;
  status: string;
  customerName: string;
  siteAddress: string;
  siteId: string;
  contact: string;
  verificationType: string;
  notes: string;
  latitude: number | null;
  longitude: number | null;
  gpsStatus: string;
  capturedAt: string | null;
  officerId: number;
  assignedOfficer: string;
  reviewDecision: string | null;
  reviewer: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseDetail extends Case {
  photos: Photo[];
  documents: Document[];
  aiResults: AIResult[];
}

export interface CaseStats {
  total: number;
  draft: number;
  submitted: number;
  needsCorrection: number;
  rejected: number;
  completed: number;
}

export interface Activity {
  id: number;
  userName: string;
  action: string;
  orderRef: string;
  severity: string;
  createdAt: string;
}

export interface CaseFilter {
  status?: string;
  q?: string;
  mine?: boolean;
}

@Injectable({ providedIn: 'root' })
export class CaseService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient, private auth: AuthService) {}

  private authHeaders(): HttpHeaders {
    const token = this.auth.getToken();
    return new HttpHeaders(token ? { Authorization: 'Bearer ' + token } : {});
  }

  // ── Mappers (null-guard every backend read — NFR-3) ──────────────────────

  private toPhoto(p: any): Photo {
    return {
      id: p?.id ?? 0,
      caseId: p?.case_id ?? 0,
      url: p?.url ?? '',
      originalName: p?.original_name ?? '',
      caption: p?.caption ?? '',
      category: p?.category ?? '',
      createdAt: p?.created_at ?? '',
    };
  }

  private toDocument(d: any): Document {
    return {
      id: d?.id ?? 0,
      caseId: d?.case_id ?? 0,
      url: d?.url ?? '',
      originalName: d?.original_name ?? '',
      documentType: d?.document_type ?? '',
      contentType: d?.content_type ?? '',
      createdAt: d?.created_at ?? '',
    };
  }

  private toAIResult(r: any): AIResult {
    return {
      id: r?.id ?? 0,
      caseId: r?.case_id ?? 0,
      photoId: r?.photo_id ?? null,
      documentId: r?.document_id ?? null,
      photoQualityScore: r?.photo_quality_score ?? null,
      photoQualityPass: r?.photo_quality_pass ?? null,
      requiredObjects: Array.isArray(r?.required_objects)
        ? r.required_objects.map((o: any) => ({
            name: o?.name ?? '',
            present: !!o?.present,
          }))
        : null,
      requiredObjectsPass: r?.required_objects_pass ?? null,
      documentTypeDetected: r?.document_type_detected ?? null,
      documentTypeConfidence: r?.document_type_confidence ?? null,
      ocrText: r?.ocr_text ?? null,
      extractedFields: r?.extracted_fields ?? null,
      detections: this.toDetections(r?.extracted_fields),
      note: r?.note ?? '',
      createdAt: r?.created_at ?? '',
    };
  }

  private toDetections(extracted: any): Detection[] {
    const list = extracted?.detections;
    if (!Array.isArray(list)) return [];
    return list
      .map((d: any) => ({
        label: d?.label ?? '',
        confidence: typeof d?.confidence === 'number' ? d.confidence : 0,
        box: {
          x: Number(d?.box?.x) || 0,
          y: Number(d?.box?.y) || 0,
          w: Number(d?.box?.w) || 0,
          h: Number(d?.box?.h) || 0,
        },
      }))
      .filter((d: Detection) => d.label && (d.box.w > 0 || d.box.h > 0));
  }

  private toCase(c: any): Case {
    return {
      id: c?.id ?? 0,
      caseRef: c?.case_ref ?? '',
      status: c?.status ?? '',
      customerName: c?.customer_name ?? '',
      siteAddress: c?.site_address ?? '',
      siteId: c?.site_id ?? '',
      contact: c?.contact ?? '',
      verificationType: c?.verification_type ?? '',
      notes: c?.notes ?? '',
      latitude: c?.latitude ?? null,
      longitude: c?.longitude ?? null,
      gpsStatus: c?.gps_status ?? 'unavailable',
      capturedAt: c?.captured_at ?? null,
      officerId: c?.officer_id ?? 0,
      assignedOfficer: c?.assigned_officer ?? '',
      reviewDecision: c?.review_decision ?? null,
      reviewer: c?.reviewer ?? null,
      reviewComment: c?.review_comment ?? null,
      reviewedAt: c?.reviewed_at ?? null,
      createdAt: c?.created_at ?? '',
      updatedAt: c?.updated_at ?? '',
    };
  }

  private toCaseDetail(c: any): CaseDetail {
    return {
      ...this.toCase(c),
      photos: Array.isArray(c?.photos) ? c.photos.map((p: any) => this.toPhoto(p)) : [],
      documents: Array.isArray(c?.documents) ? c.documents.map((d: any) => this.toDocument(d)) : [],
      aiResults: Array.isArray(c?.ai_results) ? c.ai_results.map((r: any) => this.toAIResult(r)) : [],
    };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  list(filter?: CaseFilter): Observable<Case[]> {
    let params: Record<string, string> = {};
    if (filter?.status) params['status'] = filter.status;
    if (filter?.q) params['q'] = filter.q;
    if (filter?.mine) params['mine'] = 'true';
    return this.http
      .get<any[]>(`${this.apiUrl}/cases`, { headers: this.authHeaders(), params })
      .pipe(map(list => (Array.isArray(list) ? list.map(c => this.toCase(c)) : [])));
  }

  getStats(): Observable<CaseStats> {
    return this.http
      .get<any>(`${this.apiUrl}/cases/stats`, { headers: this.authHeaders() })
      .pipe(
        map(s => ({
          total: s?.total ?? 0,
          draft: s?.draft ?? 0,
          submitted: s?.submitted ?? 0,
          needsCorrection: s?.needs_correction ?? 0,
          rejected: s?.rejected ?? 0,
          completed: s?.completed ?? 0,
        }))
      );
  }

  getActivity(limit = 20): Observable<Activity[]> {
    return this.http
      .get<any[]>(`${this.apiUrl}/cases/activity`, {
        headers: this.authHeaders(),
        params: { limit: String(limit) },
      })
      .pipe(
        map(list =>
          Array.isArray(list)
            ? list.map(a => ({
                id: a?.id ?? 0,
                userName: a?.user_name ?? '',
                action: a?.action ?? '',
                orderRef: a?.order_ref ?? '',
                severity: a?.severity ?? 'info',
                createdAt: a?.created_at ?? '',
              }))
            : []
        )
      );
  }

  get(ref: string): Observable<CaseDetail> {
    return this.http
      .get<any>(`${this.apiUrl}/cases/${encodeURIComponent(ref)}`, {
        headers: this.authHeaders(),
      })
      .pipe(map(c => this.toCaseDetail(c)));
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  create(body: {
    customerName: string;
    siteAddress: string;
    siteId?: string;
    contact?: string;
    verificationType?: string;
    notes?: string;
  }): Observable<CaseDetail> {
    return this.http
      .post<any>(
        `${this.apiUrl}/cases`,
        {
          customer_name: body.customerName,
          site_address: body.siteAddress,
          site_id: body.siteId ?? null,
          contact: body.contact ?? null,
          verification_type: body.verificationType ?? null,
          notes: body.notes ?? '',
        },
        { headers: this.authHeaders() }
      )
      .pipe(map(c => this.toCaseDetail(c)));
  }

  update(ref: string, body: {
    customerName?: string;
    siteAddress?: string;
    siteId?: string;
    contact?: string;
    verificationType?: string;
    notes?: string;
  }): Observable<CaseDetail> {
    const payload: Record<string, unknown> = {};
    if (body.customerName != null) payload['customer_name'] = body.customerName;
    if (body.siteAddress != null) payload['site_address'] = body.siteAddress;
    if (body.siteId != null) payload['site_id'] = body.siteId;
    if (body.contact != null) payload['contact'] = body.contact;
    if (body.verificationType != null) payload['verification_type'] = body.verificationType;
    if (body.notes != null) payload['notes'] = body.notes;
    return this.http
      .put<any>(`${this.apiUrl}/cases/${encodeURIComponent(ref)}`, payload, {
        headers: this.authHeaders(),
      })
      .pipe(map(c => this.toCaseDetail(c)));
  }

  attachPhoto(ref: string, body: {
    url: string;
    originalName?: string;
    caption?: string;
    category?: string;
  }): Observable<Photo> {
    return this.http
      .post<any>(
        `${this.apiUrl}/cases/${encodeURIComponent(ref)}/photos`,
        {
          url: body.url,
          original_name: body.originalName ?? '',
          caption: body.caption ?? '',
          category: body.category ?? '',
        },
        { headers: this.authHeaders() }
      )
      .pipe(map(p => this.toPhoto(p)));
  }

  deletePhoto(ref: string, id: number): Observable<void> {
    return this.http.delete<void>(
      `${this.apiUrl}/cases/${encodeURIComponent(ref)}/photos/${id}`,
      { headers: this.authHeaders() }
    );
  }

  attachDocument(ref: string, body: {
    url: string;
    originalName?: string;
    documentType: string;
    contentType?: string;
  }): Observable<Document> {
    return this.http
      .post<any>(
        `${this.apiUrl}/cases/${encodeURIComponent(ref)}/documents`,
        {
          url: body.url,
          original_name: body.originalName ?? '',
          document_type: body.documentType,
          content_type: body.contentType ?? '',
        },
        { headers: this.authHeaders() }
      )
      .pipe(map(d => this.toDocument(d)));
  }

  deleteDocument(ref: string, id: number): Observable<void> {
    return this.http.delete<void>(
      `${this.apiUrl}/cases/${encodeURIComponent(ref)}/documents/${id}`,
      { headers: this.authHeaders() }
    );
  }

  setGps(ref: string, body: {
    latitude: number | null;
    longitude: number | null;
    gpsStatus: string;
  }): Observable<CaseDetail> {
    return this.http
      .put<any>(
        `${this.apiUrl}/cases/${encodeURIComponent(ref)}/gps`,
        {
          latitude: body.latitude,
          longitude: body.longitude,
          gps_status: body.gpsStatus,
        },
        { headers: this.authHeaders() }
      )
      .pipe(map(c => this.toCaseDetail(c)));
  }

  submit(ref: string): Observable<CaseDetail> {
    return this.http
      .post<any>(`${this.apiUrl}/cases/${encodeURIComponent(ref)}/submit`, {}, {
        headers: this.authHeaders(),
      })
      .pipe(map(c => this.toCaseDetail(c)));
  }

  /** Run AI analysis on the case images without submitting. */
  analyze(ref: string): Observable<CaseDetail> {
    return this.http
      .post<any>(`${this.apiUrl}/cases/${encodeURIComponent(ref)}/analyze`, {}, {
        headers: this.authHeaders(),
      })
      .pipe(map(c => this.toCaseDetail(c)));
  }

  approve(ref: string, comment: string): Observable<CaseDetail> {
    return this.review(ref, 'approve', comment);
  }

  reject(ref: string, comment: string): Observable<CaseDetail> {
    return this.review(ref, 'reject', comment);
  }

  requestCorrection(ref: string, comment: string): Observable<CaseDetail> {
    return this.review(ref, 'request-correction', comment);
  }

  private review(ref: string, action: string, comment: string): Observable<CaseDetail> {
    return this.http
      .post<any>(
        `${this.apiUrl}/cases/${encodeURIComponent(ref)}/${action}`,
        { comment },
        { headers: this.authHeaders() }
      )
      .pipe(map(c => this.toCaseDetail(c)));
  }
}
