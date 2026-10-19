# Requirements — Field Site Verification Workflow

## Summary

Rewrite the existing "PMR image-labeling dashboard" (Angular 22 + FastAPI) into a **Field Site Verification** workflow system. A **Field Officer** visits a site, captures customer/site details, photos, and documents; the system records GPS location and timestamps; an **AI validation service** produces structured results on photos and documents; the officer submits the case; a **Front Office** reviewer approves, rejects, or sends it back for correction; corrected cases are resubmitted; approved cases are marked Completed.

The transformation reuses the working infrastructure rather than reinventing it: JWT auth with bcrypt hashing (`backend/routers/auth.py`), the bcrypt-seed fallback (`backend/seed.py`), file upload storage and `/uploads` static serving (`backend/routers/uploads.py`, `backend/main.py`), SQLAlchemy + SQLite (`backend/database.py`), the `models/*` re-export shims, and the Angular auth/service/routing patterns. The labeling-specific domain (Order/Detection, labeling canvas UI, standalone YOLO endpoints) is replaced by the verification domain.

### Assumptions (inferred where the task was open)

- **A1 — Status model.** The canonical `VerificationCase.status` values are the exact strings `Draft`, `Submitted`, `Approved`, `Rejected`, `Needs Correction`, `Completed`. "Under Review" is represented by `Submitted` (a submitted case is implicitly under review); no separate string is stored. This is chosen over adding an "Under Review" value to keep the state machine minimal and the set-filter values finite.
- **A2 — Approved → Completed.** `Approved` is a transient decision that immediately transitions to `Completed` in the same approve operation (the review flow has no post-approval work), so a user never has to perform a second action. The design step may collapse these if it prefers, but requirements below treat Completed as the terminal approved state and Approved as the decision recorded in `review_decision`.
- **A3 — GPS fallback.** If browser geolocation is denied/unavailable, the officer may enter latitude/longitude manually; if neither is provided, the case records `gps_status = "unavailable"` with null coordinates. `captured_at` is always set server-side on submission regardless of GPS outcome.
- **A4 — AI validation trigger.** AI validation runs server-side when the officer submits (and re-runs on resubmit), producing/refreshing persisted `AIValidationResult` rows. It is a deterministic/heuristic+stub service (see FR-7); no new Python packages are added. Pillow 10.3.0 is already in `backend/requirements.txt` and importable in `backend/.venv`, so photo-quality heuristics may rely on it.
- **A5 — Roles.** Roles become `field_officer`, `front_office`, and `admin` (admin retained for user management and deletes, mapping to the existing `require_admin`). The `role` string column is reused as-is.
- **A6 — Photos/documents reuse uploads.** Photos and documents are uploaded through the existing `/uploads` endpoints (image validation already present) and referenced by URL from `CasePhoto`/`CaseDocument` rows. Documents additionally allow PDF; see NFR and FR-4.
- **A7 — DB reset.** Because the schema changes, `backend/pmr_dashboard.db` is reset (dropped/recreated) and re-seeded so a fresh seed works; no migration of old labeling data is required.

---

## Functional Requirements

### FR-1 — Create site verification (Field Officer)
1. A field officer SHALL be able to create a `VerificationCase` in `Draft` status.
2. On create, the system SHALL assign the authenticated officer as the case's `assigned_officer` (owner) and generate a unique human-readable `case_ref` (e.g. `VC001`), mirroring the old `order_id` uniqueness constraint (409 on collision).
3. Customer/site fields SHALL include: `customer_name`, `site_address`, `site_id`, `contact`, `verification_type` (purpose), and `notes`. `customer_name` and `site_address` are required; the rest are optional.

### FR-2 — Capture customer/site details (Field Officer)
1. The officer SHALL be able to set/update all customer/site detail fields on a case they own while it is in `Draft` or `Needs Correction` status.
2. Pydantic validation SHALL enforce types and length limits; the frontend SHALL null-guard every field on read.

### FR-3 — Capture photos (Field Officer)
1. The officer SHALL be able to attach one or more site photos to a case via the existing image upload endpoint, producing `CasePhoto` rows that store the stored URL, original filename, and optional caption/category.
2. Photo uploads SHALL reuse the existing type/size guardrails in `backend/routers/uploads.py` (allowed image extensions/MIME, `MAX_UPLOAD_BYTES`).

### FR-4 — Capture documents (Field Officer)
1. The officer SHALL be able to attach zero or more documents to a case, producing `CaseDocument` rows storing the stored URL, original filename, and a `document_type` (one of a defined set: `ID`, `Utility Bill`, `Agreement`, `Other`).
2. Document uploads SHALL accept images and PDF; the allowed set SHALL be defined explicitly in the design and enforced server-side (415 on unsupported type).

### FR-5 — Capture GPS/location (System)
1. The frontend SHALL request coordinates via the browser Geolocation API when the officer captures location.
2. The frontend SHALL send `latitude`/`longitude` to the backend to be stored on the case.
3. If geolocation is denied/unavailable, the UI SHALL allow manual lat/long entry; if neither is supplied, the case SHALL record `gps_status = "unavailable"` with null coordinates (assumption A3).
4. The backend SHALL set `captured_at` server-side (UTC) at submission time; the client SHALL NOT be trusted to set it.

### FR-6 — Submit verification (Field Officer)
1. The officer SHALL be able to submit a case they own that is in `Draft` or `Needs Correction` status, transitioning it to `Submitted`.
2. On submit, the backend SHALL set `captured_at`, run AI validation (FR-7), and record an activity-log entry.
3. Submission SHALL be rejected (409/422) if the case is not in a submittable status or is missing required details/photos (minimum validation defined in design).

### FR-7 — AI validation (AI/System)
1. On submit/resubmit, a backend **AI validation service** SHALL produce structured `AIValidationResult` records persisted with the case, each optionally linked to a specific photo or document.
2. The result shape SHALL include, at minimum:
   - `photo_quality`: numeric score (0–1 or 0–100, defined in design) plus `pass`/`fail` boolean.
   - `required_objects_present`: list of expected objects/equipment with a per-item present flag, plus an overall `pass`/`fail`.
   - `document_type`: detected type string plus `confidence` (0–1).
   - `ocr_text` and/or `extracted_fields`: text/structured fields where applicable.
3. The implementation SHALL be deterministic/heuristic or a clearly marked stub (no heavy ML dependency added):
   - Photo quality MAY use Pillow (confirmed available) for resolution/brightness heuristics.
   - Document-type detection MAY use filename/content-type/extension heuristics.
   - OCR/extracted fields MAY be a clearly-labeled placeholder returning empty/stubbed values.
   - Required-objects MAY reuse the existing YOLOv8 model **only if straightforward**, folded into the AI service — not as a standalone labeling endpoint. If YOLO is not used, required-objects SHALL be a documented stub.
4. Every stub-vs-real boundary SHALL be documented in code comments and in the design.
5. AI validation failures (e.g. unreadable image, model load error) SHALL NOT block submission: the case still transitions to `Submitted`, and the failure SHALL be recorded as a result with a `pass=fail`/error note so the reviewer sees it.

### FR-8 — Review submission (Front Office)
1. A front-office user SHALL be able to list and open any `Submitted` case.
2. The review view SHALL present customer/site details, photos, documents, GPS/location, and AI validation results together.
3. The frontend SHALL null-guard all nested result data (scores, lists, extracted fields may be absent).

### FR-9 — Approve verification (Front Office)
1. A front-office user SHALL be able to approve a `Submitted` case, recording `review_decision`, `reviewer`, `review_comment`, and transitioning the case to `Completed` (assumption A2).

### FR-10 — Reject verification (Front Office)
1. A front-office user SHALL be able to reject a `Submitted` case, recording `review_decision = Rejected`, `reviewer`, and a required `review_comment`, transitioning the case to `Rejected` (terminal).

### FR-11 — Request correction (Front Office)
1. A front-office user SHALL be able to send a `Submitted` case back for correction, recording `review_decision = Needs Correction`, `reviewer`, and a required `review_comment`, transitioning the case to `Needs Correction`.

### FR-12 — Resubmit corrected information (Field Officer)
1. The owning officer SHALL be able to edit a `Needs Correction` case (details/photos/documents/GPS) and resubmit it, transitioning it back to `Submitted` and re-running AI validation (FR-7).

### FR-13 — Track verification status (Field Officer / Front Office)
1. Both roles SHALL be able to view case status. A list/grid (reusing the ag-grid dashboard pattern) SHALL show `case_ref`, `customer_name`, `site_id`, `status`, `assigned_officer`, and `captured_at`.
2. The set-filter on the status column SHALL offer exactly the canonical status strings (A1), replacing the old `Pending/In Progress/Completed/Rejected` values in `src/app/config/order-columns.ts`.
3. A dashboard stats/KPI endpoint SHALL return counts per status (replacing `DashboardStats`).

### FR-14 — View completed cases (Front Office)
1. A front-office user SHALL be able to filter/list cases in `Completed` status.

### FR-15 — Role-based routing & auth (both)
1. `TokenResponse` SHALL continue to carry `user_role`; the Angular `AuthService` SHALL store it so the app can route by role (field officer → capture/case views; front office → review/completed views).
2. The route guard SHALL continue to block unauthenticated access; role-aware guarding SHALL prevent a field officer from reaching review-only routes and vice versa (final route map defined in design).

---

## Status Transitions (state machine)

The design SHALL implement exactly these transitions; any other transition SHALL be rejected (409/422):

| From | Action (actor) | To |
|------|----------------|-----|
| (none) | create (Field Officer) | `Draft` |
| `Draft` | submit (Field Officer, owner) | `Submitted` |
| `Submitted` | approve (Front Office) | `Completed` |
| `Submitted` | reject (Front Office) | `Rejected` |
| `Submitted` | request correction (Front Office) | `Needs Correction` |
| `Needs Correction` | resubmit (Field Officer, owner) | `Submitted` |

`Completed` and `Rejected` are terminal. `review_decision` records the literal decision (`Approved`/`Rejected`/`Needs Correction`) even when the stored status is `Completed`.

---

## Role-Based Authorization Boundaries

- **AUTHZ-1** — Only authenticated users may call any case endpoint (reuse `get_current_user`).
- **AUTHZ-2** — Field officers MAY create cases and MAY read/update/submit/resubmit **only cases they own** (`assigned_officer == current user`). Attempting to act on another officer's case SHALL return 403.
- **AUTHZ-3** — Front-office users MAY read any case and MAY approve/reject/request-correction, but MAY NOT edit customer/site details or submit on an officer's behalf.
- **AUTHZ-4** — Admin retains destructive/user-management capability (reuse `require_admin` for deletes and `/auth/users`).
- **AUTHZ-5** — The AI validation action is system-triggered on submit; there is no client-callable "label this" endpoint that bypasses case ownership.

---

## AI Validation Result Shape (contract)

The design SHALL define a Pydantic schema (and matching ORM) producing JSON of the following shape per case (one aggregate plus optional per-asset entries):

```
AIValidationResult {
  id, case_id,
  photo_id?        # link to a CasePhoto, nullable
  document_id?     # link to a CaseDocument, nullable
  photo_quality_score: float            # defined range
  photo_quality_pass: bool
  required_objects: [ { name: str, present: bool } ]
  required_objects_pass: bool
  document_type_detected: str | null
  document_type_confidence: float | null
  ocr_text: str | null                  # may be stubbed/empty
  extracted_fields: object | null       # may be stubbed/empty
  note: str                             # e.g. error/stub marker
  created_at
}
```

Fields that a given run cannot populate SHALL be null (not fabricated), and the Front Office UI SHALL render missing values gracefully.

---

## GPS Capture / Fallback Behavior (contract)

- **GPS-1** — Happy path: browser grants location → frontend posts `latitude`/`longitude` → stored on case, `gps_status = "captured"`.
- **GPS-2** — Denied/unavailable: UI prompts for manual lat/long → if provided, `gps_status = "manual"`.
- **GPS-3** — Neither available: `latitude`/`longitude` null, `gps_status = "unavailable"`; submission still allowed.
- **GPS-4** — `captured_at` is always set server-side (UTC) at submit; coordinate values are range-validated (lat −90..90, long −180..180) by Pydantic, rejecting out-of-range input (422).

---

## Non-Functional Requirements

- **NFR-1 — Framework lock.** No framework changes: Angular 22 standalone + strict/strictTemplates, FastAPI + SQLAlchemy + SQLite + python-jose + passlib/bcrypt. No new Python packages beyond `backend/requirements.txt`; Pillow 10.3.0 is already present and MAY be used.
- **NFR-2 — Reuse not reinvent.** Preserve JWT auth, `"sub"`-as-string handling, bcrypt hashing, the seed bcrypt fallback, upload storage/static `/uploads` serving, CORS for :4200/:4201, and the `models/orm.py` + `models/schemas.py` re-export shims (kept in sync with `database.py`/`schemas.py`).
- **NFR-3 — Untrusted input.** All request bodies validated by Pydantic v2; all frontend reads of backend data null-guarded (follow the `?? ''` / `Array.isArray(...)` pattern already in `order.service.ts`).
- **NFR-4 — No hardcoded URLs.** Frontend services SHALL read `environment.apiUrl` and attach `Authorization: Bearer <token>` via an `authHeaders()` helper, as the existing services do.
- **NFR-5 — Build/import health.** `npx ng build --configuration development` SHALL pass with zero TS/template errors; `cd backend && python -c "import main"` (via `backend/.venv/bin/python`) SHALL exit 0; `uvicorn main:app --port 8000` SHALL start.
- **NFR-6 — Seed data.** Seeding SHALL reset the SQLite DB (schema changed) and create demo `field_officer` and `front_office` users (password `pwd`, bcrypt fallback intact) plus demo cases spanning every status (`Draft`, `Submitted`, `Needs Correction`, `Rejected`, `Completed`) with at least one AI validation result for a submitted/reviewed case.

---

## Acceptance Criteria (testable, numbered)

1. A field officer can log in and create a case; the response has `status = "Draft"`, a unique `case_ref`, and `assigned_officer` equal to that officer. (FR-1)
2. Creating a case with a duplicate `case_ref` returns 409. (FR-1)
3. An officer can save customer/site details (`customer_name`, `site_address`, `site_id`, `contact`, `verification_type`, `notes`) on their own `Draft` case; missing `customer_name` or `site_address` returns 422. (FR-2)
4. An officer can attach photos via `/uploads`; a non-image file is rejected with 415 and an oversized file with 413. (FR-3)
5. An officer can attach a document with `document_type` in the allowed set; an unsupported document type/extension returns 415. (FR-4)
6. Posting valid coordinates stores them with `gps_status = "captured"`; posting no coordinates stores `gps_status = "unavailable"` with null lat/long; latitude 100 returns 422. (FR-5, GPS-1/3/4)
7. Submitting a `Draft` case transitions it to `Submitted`, sets `captured_at` server-side, and creates `AIValidationResult` row(s). (FR-6, FR-7)
8. `AIValidationResult` includes `photo_quality_*`, `required_objects`/`required_objects_pass`, `document_type_detected`/`confidence`, and `ocr_text`/`extracted_fields` fields; unpopulated fields are null, not fabricated. (FR-7)
9. If AI validation errors on an asset, the case still becomes `Submitted` and a result row records the failure. (FR-7.5)
10. A front-office user can open a `Submitted` case and see details, photos, documents, GPS, and AI results in one view. (FR-8)
11. A front-office user can approve a `Submitted` case → status `Completed`, `review_decision = Approved`, `reviewer` and `review_comment` recorded. (FR-9)
12. A front-office user can reject a `Submitted` case → status `Rejected` with a required `review_comment`; empty comment returns 422. (FR-10)
13. A front-office user can request correction → status `Needs Correction` with a required `review_comment`. (FR-11)
14. The owning officer can edit and resubmit a `Needs Correction` case → status `Submitted`, and AI validation re-runs. (FR-12)
15. Any disallowed transition (e.g. approving a `Draft` case, resubmitting a `Completed` case) returns 409/422. (State machine)
16. A field officer calling an approve/reject/request-correction endpoint returns 403; a front-office user editing/submitting an officer's case returns 403. (AUTHZ-2/3)
17. A field officer acting on a case they do not own returns 403. (AUTHZ-2)
18. The status list/grid shows `case_ref`, `customer_name`, `site_id`, `status`, `assigned_officer`, `captured_at`, and its status set-filter lists exactly the canonical statuses. (FR-13)
19. The KPI/stats endpoint returns counts per canonical status. (FR-13.3)
20. A front-office user can filter to `Completed` cases. (FR-14)
21. `TokenResponse.user_role` is stored client-side and the app routes field officers and front-office users to their respective views; the guard still blocks unauthenticated access. (FR-15)
22. `npx ng build --configuration development` completes with zero errors. (NFR-5)
23. `backend/.venv/bin/python -c "import main"` exits 0 and `uvicorn main:app --port 8000` starts cleanly. (NFR-5)
24. Running the seed resets the DB and creates `field_officer` + `front_office` demo users (login with `pwd` succeeds) and demo cases covering every status, including at least one with AI validation results. (NFR-6)
25. All frontend data access null-guards backend responses (no crash when optional fields/arrays are absent). (NFR-3)
26. No new Python package appears in `backend/requirements.txt`; the AI service's stub-vs-real boundaries are documented in code. (NFR-1, FR-7.4)

---

## Out of Scope

- The legacy image-labeling canvas UI and manual bounding-box editing (`src/app/labeling/*`, `LabelingService`, `DetectionService` label persistence) — removed or repurposed, not maintained as a user feature.
- A standalone client-callable YOLO/labeling endpoint; required-object detection, if used, lives inside the AI validation service only.
- Real production-grade OCR and ML object detection accuracy; OCR is a documented placeholder and object detection is heuristic/optional-YOLO.
- Migration of existing labeling (Order/Detection) data; the DB is reset.
- Multi-tenant org structures, notifications/email, offline mobile sync, map rendering of GPS, and audit beyond the existing `ActivityLog`.
- Changing auth mechanisms, token lifetime policy, or password requirements beyond what already exists.
