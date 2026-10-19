# Design — Field Site Verification Workflow

## Overview

This rewrite converts the existing PMR image-labeling dashboard (Angular 22 standalone + FastAPI/SQLAlchemy/SQLite) into a **Field Site Verification** workflow. A Field Officer creates a verification case, captures customer/site details, uploads photos and documents, captures GPS, and submits. On submit the backend runs an AI validation service (Pillow-based photo-quality heuristics + **real YOLOv8** object/equipment presence + heuristic document typing + stubbed OCR), persists structured `AIValidationResult` rows, and transitions the case to `Submitted`. A Front Office reviewer reads the full case (details + photos + documents + GPS + AI results) and approves (→ `Completed`), rejects (→ `Rejected`), or requests correction (→ `Needs Correction`). The owning officer edits a `Needs Correction` case and resubmits, re-running AI validation.

The strategy is **reuse, not reinvent**, done **in place**. This is an in-place rewrite of the existing project at the repo root (`src/` and `backend/`), carried into this worktree — there is **no second/parallel project directory and no duplicate `src` tree**. New components/services/models replace the existing files within the current structure. The entire auth stack (JWT, `"sub"`-as-string, bcrypt, seed fallback), the uploads router + `/uploads` static mount, the SQLAlchemy/SQLite engine, the `models/` re-export shims, the Angular auth/service/guard/routing patterns, the ag-grid dashboard, and the ng2-charts chart component are all preserved and repurposed. The labeling domain (`Order`/`Detection`, the canvas bbox UI, the standalone YOLO/labeling endpoints) is **removed** and replaced by the verification domain. The YOLO model is **reused** (not deleted) and folded *inside* the AI service as the real object-presence check (see §4 — this is a locked requirement, not optional); a guaranteed fallback exists only so a model/runtime failure can never block submission (FR-7.5), not as a substitute for running the model on the happy path.

**Technology stack (locked):** FastAPI 0.111, SQLAlchemy 2.0, SQLite, pydantic v2.7 `[email]`, python-jose, passlib[bcrypt] 1.7.4 + bcrypt 4.0.1, python-multipart, Pillow 10.3.0, ultralytics 8.3.40 (already present; used for the real object-presence check), python-dotenv. Frontend: Angular 22 standalone + strict/strictTemplates, ag-grid-community/ag-grid-angular, ng2-charts/chart.js. **No new Python or npm packages are added.**

**Import-health verified during design:** `backend/.venv/bin/python` exists; `import PIL` → Pillow 10.3.0 OK; `import ultralytics` → 8.3.40 OK. Therefore the AI service relies on Pillow unconditionally for photo quality and runs the **real YOLO model** for object presence, with a `try/except` fallback so a model-load failure never *blocks* submission (but the model, not the fallback, is the happy path).

**Clarifications locked (from parent session, treated as decided requirements):**
- **CL-1 — YOLO is required for object presence.** The required-objects/equipment check runs the real YOLOv8 model (`backend/yolov8n.pt` via ultralytics) folded into the AI service. It must not be replaced by a heuristic. Photo-quality (Pillow), document-type (heuristic), and OCR (stub) are unchanged. (See §4.2.)
- **CL-2 — Roles resolved (supersedes assumption A5).** Roles are `field_officer`, `front_office`, and `admin`. Signup lets the user pick `field_officer` or `front_office`; `admin` is seeded only. After login, route by role. (See §6.1, §6.4.)
- **CL-3 — In-place rewrite.** Enhance the existing repo-root `src/` and `backend/` in place inside this worktree; no duplicate/parallel project or second `src` tree.

---

## 1. Domain model (SQLAlchemy ORM — `backend/database.py`)

`database.py` remains the single source of truth for ORM classes; `models/orm.py` and `models/__init__.py` re-export them. The old `Order` and `Detection` classes are **deleted**; `User` and `ActivityLog` are kept (`User.role` repurposed, a new `cases` relationship added). New classes: `VerificationCase`, `CasePhoto`, `CaseDocument`, `AIValidationResult`.

Keep the existing module docstring style, `datetime.utcnow` defaults, and `relationship(... cascade="all, delete-orphan")` pattern already used by `Order.detections`.

### 1.1 Status strings and transitions

Status is stored as a plain `String` column (matches the existing `order_status` style; no DB-level enum). A module-level constant tuple defines the canonical set, and a transition map enforces the state machine in the router layer.

```python
# database.py — canonical status values (single source of truth)
CASE_STATUSES = ("Draft", "Submitted", "Approved", "Rejected", "Needs Correction", "Completed")

# review decisions recorded on the case independently of status
REVIEW_DECISIONS = ("Approved", "Rejected", "Needs Correction")

DOCUMENT_TYPES = ("ID", "Utility Bill", "Agreement", "Other")

GPS_STATUSES = ("captured", "manual", "unavailable")
```

Allowed transitions (enforced in the router, see §3.3). `Approved` is never persisted as a `status` — approval writes `status="Completed"` and `review_decision="Approved"` in one operation (requirements A2). `Approved` remains in `CASE_STATUSES` only as a legal `review_decision` value; the KPI endpoint counts it via `review_decision`, not `status` (see §3.3 stats).

| From status | Action (actor) | To status | review_decision written |
|---|---|---|---|
| (none) | create (field_officer) | `Draft` | — |
| `Draft` | submit (owner officer) | `Submitted` | — |
| `Needs Correction` | resubmit (owner officer) | `Submitted` | — |
| `Submitted` | approve (front_office) | `Completed` | `Approved` |
| `Submitted` | reject (front_office) | `Rejected` | `Rejected` |
| `Submitted` | request correction (front_office) | `Needs Correction` | `Needs Correction` |

`Completed` and `Rejected` are terminal. Any other transition → `409 Conflict`.

### 1.2 `User` (modified)

Only the `role` comment/default semantics change; the column type stays `String(20)`. Default stays `"field_officer"` (replacing `"labeler"`), and the `orders` relationship is replaced by `cases`.

| Column | Type | Null | FK | Default | Notes |
|---|---|---|---|---|---|
| id | Integer PK | no | — | — | index |
| name | String(100) | no | — | — | |
| email | String(200) | no | — | — | unique, index |
| hashed_pw | String(200) | no | — | — | bcrypt |
| role | String(20) | no | — | `"field_officer"` | `field_officer` \| `front_office` \| `admin` |
| is_active | Boolean | yes | — | `True` | |
| created_at | DateTime | yes | — | `utcnow` | |

Relationship: `cases = relationship("VerificationCase", back_populates="officer")`.

### 1.3 `VerificationCase`

| Column | Type | Null | FK | Default | Notes |
|---|---|---|---|---|---|
| id | Integer PK | no | — | — | index |
| case_ref | String(50) | no | — | — | unique, index (e.g. `VC001`); 409 on collision |
| status | String(50) | no | — | `"Draft"` | one of `CASE_STATUSES` |
| customer_name | String(200) | no | — | — | required |
| site_address | String(400) | no | — | — | required |
| site_id | String(100) | yes | — | `None` | optional |
| contact | String(100) | yes | — | `None` | optional |
| verification_type | String(100) | yes | — | `None` | purpose/category |
| notes | Text | yes | — | `""` | |
| latitude | Float | yes | — | `None` | −90..90 validated at schema layer |
| longitude | Float | yes | — | `None` | −180..180 validated at schema layer |
| gps_status | String(20) | no | — | `"unavailable"` | one of `GPS_STATUSES` |
| captured_at | DateTime | yes | — | `None` | set server-side on submit (UTC) |
| officer_id | Integer | no | users.id | — | owner (assigned officer) |
| review_decision | String(30) | yes | — | `None` | one of `REVIEW_DECISIONS` |
| reviewer | String(100) | yes | — | `None` | reviewer display name |
| review_comment | Text | yes | — | `None` | required for reject / request-correction |
| reviewed_at | DateTime | yes | — | `None` | set when a review decision is recorded |
| created_at | DateTime | yes | — | `utcnow` | |
| updated_at | DateTime | yes | — | `utcnow` / `onupdate=utcnow` | |

Relationships:
- `officer = relationship("User", back_populates="cases")`
- `photos = relationship("CasePhoto", back_populates="case", cascade="all, delete-orphan")`
- `documents = relationship("CaseDocument", back_populates="case", cascade="all, delete-orphan")`
- `ai_results = relationship("AIValidationResult", back_populates="case", cascade="all, delete-orphan")`

`assigned_officer` in the requirements maps to `officer_id` + the response field `assigned_officer` (officer's display name) in schemas.

### 1.4 `CasePhoto`

| Column | Type | Null | FK | Default | Notes |
|---|---|---|---|---|---|
| id | Integer PK | no | — | — | |
| case_id | Integer | no | verification_cases.id | — | index |
| url | String(300) | no | — | — | `/uploads/<name>` from uploads router |
| original_name | String(300) | yes | — | `""` | client filename |
| caption | String(300) | yes | — | `""` | optional |
| category | String(100) | yes | — | `""` | optional (e.g. "Front", "Meter") |
| created_at | DateTime | yes | — | `utcnow` | |

`case = relationship("VerificationCase", back_populates="photos")`.

### 1.5 `CaseDocument`

| Column | Type | Null | FK | Default | Notes |
|---|---|---|---|---|---|
| id | Integer PK | no | — | — | |
| case_id | Integer | no | verification_cases.id | — | index |
| url | String(300) | no | — | — | `/uploads/<name>` |
| original_name | String(300) | yes | — | `""` | |
| document_type | String(50) | no | — | `"Other"` | one of `DOCUMENT_TYPES` |
| content_type | String(100) | yes | — | `""` | stored MIME from upload |
| created_at | DateTime | yes | — | `utcnow` | |

`case = relationship("VerificationCase", back_populates="documents")`.

### 1.6 `AIValidationResult`

One row per AI run per asset (plus optionally one aggregate row with both FKs null). Nullable `photo_id`/`document_id` allow linking a result to a specific photo or document, or neither (aggregate). JSON-ish structured fields use SQLAlchemy's `JSON` type (SQLite stores it as TEXT; SQLAlchemy serializes transparently).

```python
from sqlalchemy import JSON
```

| Column | Type | Null | FK | Default | Notes |
|---|---|---|---|---|---|
| id | Integer PK | no | — | — | |
| case_id | Integer | no | verification_cases.id | — | index |
| photo_id | Integer | yes | case_photos.id | `None` | nullable link |
| document_id | Integer | yes | case_documents.id | `None` | nullable link |
| photo_quality_score | Float | yes | — | `None` | 0..1 (defined range, §4) |
| photo_quality_pass | Boolean | yes | — | `None` | |
| required_objects | JSON | yes | — | `None` | `[{ "name": str, "present": bool }]` |
| required_objects_pass | Boolean | yes | — | `None` | |
| document_type_detected | String(50) | yes | — | `None` | |
| document_type_confidence | Float | yes | — | `None` | 0..1 |
| ocr_text | Text | yes | — | `None` | stub → `None`/empty |
| extracted_fields | JSON | yes | — | `None` | stub → `None`/`{}` |
| note | String(300) | no | — | `""` | stub/error marker, e.g. `"photo-quality:real; objects:yolo; ocr:stub"` |
| created_at | DateTime | yes | — | `utcnow` | |

`case = relationship("VerificationCase", back_populates="ai_results")`. No back-populate needed on photo/document (one-directional FK is enough; avoids extra relationship churn).

**Range of `photo_quality_score`: 0..1** (float). Chosen over 0–100 for consistency with `document_type_confidence` and `confidence` conventions already in the codebase (YOLO `conf`). `pass` threshold is `>= 0.5` (constant in the AI service, §4).

### 1.7 Keeping the re-export shims in sync

`models/orm.py`, `models/__init__.py`, `models/schemas.py` are **view-only re-exports** (verified: each is a plain `from database import ...` / `from schemas import ...`). The implementer MUST update all three import lists in lockstep when the symbol set changes:

- `models/orm.py` and `models/__init__.py`: remove `Order`, `Detection`; add `VerificationCase`, `CasePhoto`, `CaseDocument`, `AIValidationResult`. Keep `Base, engine, SessionLocal, User, ActivityLog, get_db, create_tables`. Optionally re-export the new constants (`CASE_STATUSES`, `DOCUMENT_TYPES`, `GPS_STATUSES`, `REVIEW_DECISIONS`).
- `models/schemas.py` and `models/__init__.py`: remove `DetectionBox, DetectionOut, LabelBoxIn, OrderCreate, OrderUpdate, OrderOut, DashboardStats, YoloResult`; add the new schema names from §2. Keep `RegisterRequest, LoginRequest, TokenResponse, UserOut, ActivityOut, UploadResult`.

Invariant: the `__all__` lists in all three files must exactly match the symbols imported. A `python -c "import models"` smoke check (part of NFR-5) will fail loudly if a name is missing — this is the enforcement mechanism.

---

## 2. Pydantic v2 schemas (`backend/schemas.py`)

Keep the file-level `from __future__ import annotations`, the section-comment style, and `model_config = {"from_attributes": True}` on every response model. Remove all Detection/Order/Yolo/DashboardStats schemas. `UploadResult`, `UserOut`, `RegisterRequest`, `LoginRequest`, `ActivityOut` stay. `RegisterRequest.role` default changes to `"field_officer"`.

### 2.1 Auth (modified)

`TokenResponse` already carries `user_role` — kept as-is (it satisfies FR-15; the Angular `AuthService` will now store it). No change required beyond confirming `user_role` is present.

```python
class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    user_name:    str
    user_role:    str          # field_officer | front_office | admin — stored client-side
    user_id:      int
```

### 2.2 Case schemas

```python
# ── Verification case ──────────────────────────────────────────────────────
class CaseCreate(BaseModel):
    case_ref:          Optional[str] = None   # server auto-generates if omitted
    customer_name:     str = Field(min_length=1, max_length=200)
    site_address:      str = Field(min_length=1, max_length=400)
    site_id:           Optional[str] = Field(default=None, max_length=100)
    contact:           Optional[str] = Field(default=None, max_length=100)
    verification_type: Optional[str] = Field(default=None, max_length=100)
    notes:             Optional[str] = Field(default="", max_length=4000)

class CaseUpdate(BaseModel):          # details editable while Draft / Needs Correction
    customer_name:     Optional[str] = Field(default=None, min_length=1, max_length=200)
    site_address:      Optional[str] = Field(default=None, min_length=1, max_length=400)
    site_id:           Optional[str] = Field(default=None, max_length=100)
    contact:           Optional[str] = Field(default=None, max_length=100)
    verification_type: Optional[str] = Field(default=None, max_length=100)
    notes:             Optional[str] = Field(default=None, max_length=4000)

class GpsUpdate(BaseModel):
    latitude:  Optional[float] = Field(default=None, ge=-90,  le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    gps_status: str = "captured"   # captured | manual | unavailable; validated against GPS_STATUSES

    @field_validator("gps_status")
    @classmethod
    def _status_known(cls, v): ...   # raise ValueError (→422) if v not in GPS_STATUSES

    @model_validator(mode="after")
    def _coords_consistent(self):
        # if gps_status != "unavailable", both lat & long required; else both must be null
        ...

class PhotoAttach(BaseModel):
    url:           str = Field(min_length=1, max_length=300)
    original_name: Optional[str] = Field(default="", max_length=300)
    caption:       Optional[str] = Field(default="", max_length=300)
    category:      Optional[str] = Field(default="", max_length=100)

class DocumentAttach(BaseModel):
    url:           str = Field(min_length=1, max_length=300)
    original_name: Optional[str] = Field(default="", max_length=300)
    document_type: str = "Other"          # validated against DOCUMENT_TYPES → 422 if unknown
    content_type:  Optional[str] = Field(default="", max_length=100)

    @field_validator("document_type")
    @classmethod
    def _type_known(cls, v): ...          # raise ValueError if v not in DOCUMENT_TYPES

class ReviewAction(BaseModel):            # approve / reject / request-correction body
    comment: Optional[str] = Field(default=None, max_length=4000)
    # reject & request-correction require comment; the router enforces non-empty (422) for those actions.
```

### 2.3 Response schemas

```python
class PhotoOut(BaseModel):
    id: int; case_id: int; url: str
    original_name: str; caption: str; category: str
    created_at: datetime
    model_config = {"from_attributes": True}

class DocumentOut(BaseModel):
    id: int; case_id: int; url: str
    original_name: str; document_type: str; content_type: str
    created_at: datetime
    model_config = {"from_attributes": True}

class AIResultOut(BaseModel):
    id: int; case_id: int
    photo_id: Optional[int] = None
    document_id: Optional[int] = None
    photo_quality_score: Optional[float] = None
    photo_quality_pass:  Optional[bool]  = None
    required_objects:      Optional[list[dict]] = None   # [{name, present}]
    required_objects_pass: Optional[bool]        = None
    document_type_detected:   Optional[str]   = None
    document_type_confidence: Optional[float] = None
    ocr_text:         Optional[str]  = None
    extracted_fields: Optional[dict] = None
    note: str
    created_at: datetime
    model_config = {"from_attributes": True}

class CaseOut(BaseModel):                 # list-row shape (no nested children for speed)
    id: int; case_ref: str; status: str
    customer_name: str; site_address: str
    site_id: Optional[str]; contact: Optional[str]
    verification_type: Optional[str]; notes: Optional[str]
    latitude: Optional[float]; longitude: Optional[float]
    gps_status: str
    captured_at: Optional[datetime]
    officer_id: int
    assigned_officer: Optional[str] = None   # officer display name, populated in router
    review_decision: Optional[str]; reviewer: Optional[str]
    review_comment: Optional[str]; reviewed_at: Optional[datetime]
    created_at: datetime; updated_at: datetime
    model_config = {"from_attributes": True}

class CaseDetailOut(CaseOut):             # detail shape with nested children
    photos:    list[PhotoOut]   = []
    documents: list[DocumentOut] = []
    ai_results: list[AIResultOut] = []

class CaseStats(BaseModel):               # replaces DashboardStats
    total: int
    draft: int
    submitted: int
    needs_correction: int
    rejected: int
    completed: int
```

`assigned_officer` is filled by the router from `case.officer.name` (null-guarded). `CaseOut`/`CaseDetailOut` use `from_attributes`, so the router returns ORM objects and sets `assigned_officer` by constructing the schema with `model_validate` + override, or by a small mapping helper `_to_case_out(case)` that reads `case.officer.name if case.officer else None`.

---

## 3. REST API

### 3.0 Auth router (`routers/auth.py`) — reused unchanged in mechanism

No logic changes. `register`/`login`/`token`/`me`/`users` stay. `require_admin` stays. **Add two role dependencies** next to `require_admin` (same pattern):

```python
def require_field_officer(current: User = Depends(get_current_user)) -> User:
    if current.role not in ("field_officer", "admin"):
        raise HTTPException(403, "Field officer access required")
    return current

def require_front_office(current: User = Depends(get_current_user)) -> User:
    if current.role not in ("front_office", "admin"):
        raise HTTPException(403, "Front office access required")
    return current
```

`admin` is allowed through both (admin is a superset for operability; destructive/user-management still gated by `require_admin`). This satisfies AUTHZ-4 without a separate admin UI.

| Method | Path | Body | Response | Authorization |
|---|---|---|---|---|
| POST | /auth/register | RegisterRequest | TokenResponse 201 | public |
| POST | /auth/login | LoginRequest | TokenResponse | public |
| POST | /auth/token | OAuth2 form | TokenResponse | public (Swagger) |
| GET | /auth/me | — | UserOut | any authenticated |
| GET | /auth/users | — | list[UserOut] | `require_admin` |

### 3.1 Uploads router (`routers/uploads.py`) — reused, documents added

Keep `POST /uploads`, `POST /uploads/single`, `DELETE /uploads/{filename}` and all guardrails (`ALLOWED_EXT`, `ALLOWED_MIME`, `MAX_BYTES`, random stored name, path-traversal rejection on delete). The image endpoints are used for **photos** unchanged.

For **documents** (images + PDF), add a dedicated endpoint rather than loosening the image guardrails (keeps photo validation strict):

```python
ALLOWED_DOC_EXT  = ALLOWED_EXT | {".pdf"}
ALLOWED_DOC_MIME = ALLOWED_MIME | {"application/pdf"}
```

| Method | Path | Body | Response | Authorization |
|---|---|---|---|---|
| POST | /uploads | multipart `files[]` (images) | list[UploadResult] 201 | any authenticated |
| POST | /uploads/single | multipart `file` (image) | UploadResult 201 | any authenticated |
| POST | /uploads/document | multipart `file` (image or PDF) | UploadResult 201 | any authenticated |
| DELETE | /uploads/{filename} | — | 204 | `require_admin` |

`POST /uploads/document` reuses a parameterized `_store(file, allowed_ext, allowed_mime)` — refactor the existing `_store`/`_safe_ext` to take the allowed sets as arguments (default to the image sets so existing callers are unchanged). Unsupported type/extension → **415**; empty → 400; oversize → **413** (unchanged thresholds). The upload endpoints only store files and return the URL; the actual `CasePhoto`/`CaseDocument` row is created by the verification-cases attach endpoints (§3.2), which is where ownership is enforced.

### 3.2 Verification-cases router (`routers/verification.py`, prefix `/cases`)

New router replacing `routers/orders.py`. Uses `get_current_user`, the new role deps, and a shared `_log(...)` helper copied from the orders router (writes `ActivityLog`). Ownership/transition helpers:

```python
def _get_case_or_404(db, case_ref) -> VerificationCase: ...
def _require_owner(case, current): # 403 if current.role==field_officer and case.officer_id != current.id
def _next_case_ref(db) -> str:     # "VC%03d" from max existing numeric suffix; retry on 409
```

| Method | Path | Body | Response | Authorization | Notes |
|---|---|---|---|---|---|
| POST | /cases | CaseCreate | CaseDetailOut 201 | `require_field_officer` | status=`Draft`, officer_id=current.id, auto `case_ref` (409 on collision) |
| GET | /cases | query: `status?`, `q?`, `mine?`, `skip`, `limit` | list[CaseOut] | any authenticated | **field_officer sees only own cases** (forced `officer_id==current.id`); front_office/admin see all; `status`/`q` filters optional |
| GET | /cases/stats | — | CaseStats | any authenticated | counts per status; `completed` counted by status, decisions reflected in status |
| GET | /cases/activity | query: `limit` | list[ActivityOut] | any authenticated | activity feed (reused) |
| GET | /cases/{case_ref} | — | CaseDetailOut | any authenticated | field_officer: 403 unless owner; front_office/admin: any |
| PUT | /cases/{case_ref} | CaseUpdate | CaseDetailOut | `require_field_officer` + owner | 409 unless status in {`Draft`,`Needs Correction`} |
| POST | /cases/{case_ref}/photos | PhotoAttach | PhotoOut 201 | `require_field_officer` + owner | 409 unless status in {`Draft`,`Needs Correction`} |
| DELETE | /cases/{case_ref}/photos/{photo_id} | — | 204 | `require_field_officer` + owner | same status gate |
| POST | /cases/{case_ref}/documents | DocumentAttach | DocumentOut 201 | `require_field_officer` + owner | 415 if document_type∉set (schema); same status gate |
| DELETE | /cases/{case_ref}/documents/{doc_id} | — | 204 | `require_field_officer` + owner | same status gate |
| PUT | /cases/{case_ref}/gps | GpsUpdate | CaseDetailOut | `require_field_officer` + owner | stores lat/long/gps_status; 422 on out-of-range/inconsistent |
| POST | /cases/{case_ref}/submit | — | CaseDetailOut | `require_field_officer` + owner | transition Draft/Needs Correction→Submitted; see §3.3 |
| POST | /cases/{case_ref}/approve | ReviewAction | CaseDetailOut | `require_front_office` | Submitted→Completed, decision=Approved |
| POST | /cases/{case_ref}/reject | ReviewAction | CaseDetailOut | `require_front_office` | Submitted→Rejected, comment required (422 if empty) |
| POST | /cases/{case_ref}/request-correction | ReviewAction | CaseDetailOut | `require_front_office` | Submitted→Needs Correction, comment required (422 if empty) |
| DELETE | /cases/{case_ref} | — | 204 | `require_admin` | admin-only delete (AUTHZ-4) |

Notes on list filtering (FR-13/FR-14): `GET /cases?status=Completed` serves the Front Office "completed cases" view. For a field officer the server **always** restricts to their own cases regardless of a `mine` param (AUTHZ-2); `mine` is accepted but a no-op for officers and optional for front_office/admin to self-filter.

A separate standalone AI-trigger endpoint is intentionally **not** exposed (AUTHZ-5). AI validation runs only inside `/submit`.

### 3.3 Submit + review logic (concrete)

`submit`:
1. Load case (404), require owner. If `status not in {"Draft","Needs Correction"}` → **409**.
2. **Minimum-content validation** (FR-6.3): `customer_name` and `site_address` non-empty (already enforced at create, re-checked), and **at least one `CasePhoto`** attached → else **422** with a clear detail (`"At least one photo is required before submitting"`).
3. Set `captured_at = datetime.utcnow()` server-side (ignore any client value). GPS fields are whatever the latest `/gps` call stored (or `unavailable`).
4. Run AI validation (§4) inside a `try/except`; **delete** prior `AIValidationResult` rows for the case (resubmit refresh), then persist new rows. Any exception from the service is caught and recorded as one aggregate result row with `photo_quality_pass=False`, `required_objects_pass=False`, `note="ai-error: <msg>"` — submission still proceeds (FR-7.5).
5. Set `status="Submitted"`, log activity, commit, return `CaseDetailOut`.

`approve`/`reject`/`request-correction`:
1. Load case (404), `require_front_office`. If `status != "Submitted"` → **409**.
2. For reject & request-correction: `comment` must be non-empty after `strip()` → else **422**.
3. Set `review_decision`, `reviewer=current.name`, `review_comment=comment`, `reviewed_at=utcnow()`, and `status` per the transition table. Log activity (`severity`: approve→success, reject→error, correction→warning). Commit, return `CaseDetailOut`.

`stats`: counts by `status` for `draft/submitted/needs_correction/rejected/completed` and `total`. (`Approved` is not a stored status; the "approved" population is exactly the `Completed` set.)

### 3.4 Removed endpoints

Delete `routers/yolo.py` entirely and remove its import/registration from `main.py`. Delete `routers/orders.py` (replaced by `routers/verification.py`). All detection/label/order endpoints (`/orders*`, `/orders/{id}/detections`, `/orders/{id}/labels`, `/detect*`) are gone. The YOLO weights file `backend/yolov8n.pt` stays on disk and is loaded *lazily inside the AI service* (§4). The `YOLO_MODEL` env var in `.env` is retained.

---

## 4. AI validation service (`backend/services/ai_validation.py`)

New module (new `backend/services/` package with `__init__.py`). Pure functions + one orchestrator; no FastAPI/DB types in the signature so it is unit-testable in isolation. It receives plain data and returns a list of result dicts; the router persists them.

### 4.1 Interface

```python
# ai_validation.py
PHOTO_QUALITY_PASS_THRESHOLD = 0.5
REQUIRED_OBJECTS = ["building", "signage", "meter"]   # expected site equipment (heuristic/stub list)

@dataclass
class AssetRef:
    kind: str          # "photo" | "document"
    asset_id: int
    local_path: str    # absolute path under UPLOAD_DIR, resolved from the stored url
    original_name: str
    content_type: str

def validate_case(photos: list[AssetRef], documents: list[AssetRef]) -> list[dict]:
    """Return AIValidationResult-shaped dicts (one per asset + optionally one aggregate).
    Never raises for a single-asset failure — per-asset errors are captured into that
    asset's result row with a note; a catastrophic failure is caught by the router."""
```

The router resolves each `CasePhoto.url` / `CaseDocument.url` (`/uploads/<name>`) to a filesystem path via `UPLOAD_DIR / Path(url).name` and builds `AssetRef`s. Results carry `photo_id`/`document_id` so they persist with the right FK.

### 4.2 What is REAL vs HEURISTIC vs STUB (documented in code comments and here)

- **Photo quality — REAL (Pillow).** For each photo: open with `PIL.Image`, read resolution and compute a brightness/contrast heuristic (mean luminance of a downscaled grayscale, plus a sharpness proxy via variance of a simple Laplacian-like difference). Map to a 0..1 score. `photo_quality_pass = score >= 0.5`. Pillow confirmed importable (10.3.0) in `backend/.venv`, so this path runs unconditionally. If a specific image can't be opened (corrupt/unreadable), that photo's row gets `photo_quality_score=0.0, photo_quality_pass=False, note="photo-quality: unreadable image"`.
- **Required objects — REAL YOLO (locked requirement).** This check **must run the real YOLOv8 model** (`backend/yolov8n.pt` via ultralytics, confirmed importable at 8.3.40) — it is not a heuristic. The service lazy-loads YOLO exactly like the old `yolo.py::get_model` (reuse `_allow_ultralytics_globals()` and the `YOLO(YOLO_MODEL)` call, moved verbatim into this module), runs detection on each photo, and maps detected class names onto `REQUIRED_OBJECTS` presence (case-insensitive match against the model's `result.names`). `required_objects_pass = all(present)` — **pass only if every expected object is present**. The heuristic fallback exists **solely for resilience** (FR-7.5): if and only if model load or inference raises, the service falls back to marking objects `present=False` and records `note="objects: yolo-unavailable (<err>), fallback"` so the reviewer sees that detection didn't run — it is never used on the happy path. Because ultralytics loads successfully in `backend/.venv`, the real path is the normal path.
- **Document type — HEURISTIC.** Detected from `document_type` the officer selected (authoritative) cross-checked against filename/extension/content-type keywords; `document_type_detected` = best guess string, `document_type_confidence` = 1.0 when it matches the officer's selection, else ~0.5. No ML.
- **OCR / extracted fields — STUB.** `ocr_text = None`, `extracted_fields = None`, with `note` containing `"ocr: stub"`. Clearly labeled placeholder; no OCR engine is added (none is in requirements.txt). Front Office UI renders "OCR not available" when null.

Each result's `note` is a semicolon-joined provenance string, e.g. `"photo-quality:real; objects:yolo; ocr:stub"` or `"objects:yolo-unavailable→heuristic; ocr:stub"`, satisfying FR-7.4 (stub/real boundary visible in data + comments).

### 4.3 Result composition

- One result row **per photo**: `photo_id` set, `photo_quality_*` and `required_objects*` populated, document fields null.
- One result row **per document**: `document_id` set, `document_type_*` populated, photo-quality/objects null, `ocr_*` stubbed.
- No separate aggregate row is required; if a case has zero photos and zero documents (shouldn't happen post min-validation since a photo is required), the service returns a single row with `note="no assets"`.

### 4.4 Testability

`validate_case` is a pure function over `AssetRef` lists → unit-testable with a small fixture image (and a non-image path to exercise the unreadable branch) without a running server or DB. YOLO is behind a lazy loader that can be monkeypatched to force the fallback path in tests. The submit endpoint is integration-tested via TestClient (create → attach photo → submit → assert `AIValidationResult` rows exist and the case is `Submitted` even when YOLO is forced to fail).

---

## 5. GPS capture + fallback

- **Frontend (GPS capture control, §6).** On "Capture location", call `navigator.geolocation.getCurrentPosition(...)`.
  - Success → `latitude`/`longitude` from `coords`, `gps_status="captured"`; `PUT /cases/{ref}/gps`.
  - Error/denied/unsupported → show manual lat/long inputs. If the officer enters both → `gps_status="manual"`. If left blank → `gps_status="unavailable"`, coords null.
- **Backend.** `PUT /cases/{ref}/gps` validates coordinate ranges (lat −90..90, long −180..180 via pydantic `ge/le`) → **422** on out-of-range; `model_validator` enforces consistency (both present unless `unavailable`). `captured_at` is **never** accepted from the client; it is set server-side at `submit` time (FR-5.4, GPS-4). GPS is optional for submission (GPS-3) — a case with `gps_status="unavailable"` still submits.

---

## 6. Angular frontend

### 6.1 Route map (`app.routes.ts`) + role guard

Replace the `labeling` route; keep `login`/`signup`. Add role-aware lazy routes. Add a `roleGuard` factory beside `authGuard`.

```
''                      → redirect to /login
'login'                 → LoginPageComponent (public)
'signup'                → SignupComponent (public)
'officer'               → canActivate [authGuard, roleGuard(['field_officer','admin'])]
  'officer/cases'       → OfficerCaseListComponent      (case list)
  'officer/cases/new'   → OfficerCaseFormComponent      (create)
  'officer/cases/:ref'  → OfficerCaseFormComponent      (edit/resubmit, incl. Needs Correction)
'office'                → canActivate [authGuard, roleGuard(['front_office','admin'])]
  'office/review'       → ReviewQueueComponent          (Submitted queue)
  'office/review/:ref'  → CaseReviewComponent           (review detail)
  'office/completed'    → CompletedCasesComponent       (Completed list)
  'office/overview'     → OverviewComponent             (stats + chart)
'**'                    → redirect to /login
```

`auth.guard.ts`: keep `authGuard`. Add:

```typescript
export const roleGuard = (allowed: string[]): CanActivateFn => () => {
  const auth = inject(AuthService); const router = inject(Router);
  const role = auth.getRole();
  if (role && allowed.includes(role)) return true;
  // send user to their home, or login if unknown
  return router.createUrlTree([auth.homeRoute()]);
};
```

Login navigates by role: `AuthService.homeRoute()` returns `/officer/cases` for `field_officer`, `/office/review` for `front_office`/`admin`. `LoginPageComponent.onSubmit` navigates to `this.auth.homeRoute()` instead of hardcoded `/dashboard`. The success message currently interpolates the token object — fix to a plain `"Login successful"` string (strict-template/typing cleanup).

### 6.2 AuthService changes

Keep `login()` posting to `${environment.apiUrl}/auth/login` with the mock fallback, `logout()`, `isAuthenticated()`, `getToken()`, `getUsername()`. **Store the role**: the login `map` reads `res.user_role` and `localStorage.setItem('role', res.user_role)`; add `getRole(): string | null` and `homeRoute(): string`. `logout()` also removes `'role'`. The mock-fallback branch sets a default role (e.g. from `auth.json` if present, else `'field_officer'`) so strict typing holds. Keep `authHeaders()`/Bearer usage pattern in the data services (NFR-4).

### 6.3 Services (new/repurposed/deleted)

- **New `CaseService`** (`services/case.service.ts`) — the central data service. Mirrors `order.service.ts` structure: `private apiUrl = environment.apiUrl`, `authHeaders()`, snake→camel mapping with `?? ''` / `Array.isArray(...)` null-guards. Methods: `list(filter?)`, `getStats()`, `getActivity()`, `get(ref)`, `create(body)`, `update(ref, body)`, `attachPhoto(ref, body)`, `deletePhoto(ref, id)`, `attachDocument(ref, body)`, `deleteDocument(ref, id)`, `setGps(ref, body)`, `submit(ref)`, `approve(ref, comment)`, `reject(ref, comment)`, `requestCorrection(ref, comment)`. Defines TS interfaces `Case`, `CaseDetail`, `Photo`, `Document`, `AIResult` matching §2.3 (camelCase), every field null-guarded on read (NFR-3).
- **New `UploadService`** (`services/upload.service.ts`) — extracted from the reusable upload logic in `labeling.service.ts`: `uploadImage(file): Observable<{url, originalName, contentType, size}>` → `POST /uploads/single`; `uploadDocument(file)` → `POST /uploads/document`. Keeps the `${apiUrl}${url}` absolute-URL resolution and `authHeaders()`.
- **Repurpose `StatusChartService`** — keep it; point `getOrders()` → `getCases()` reading `/cases` and mapping `status`/`created_at`. Chart buckets by the new statuses.
- **Delete `DetectionService`** (`services/detection.service.ts`) and **`LabelingService`** (`services/labeling.service.ts`) — labeling-only; their reusable upload bit is lifted into `UploadService`.
- **Delete `OrderService`** (`services/order.service.ts`) — replaced by `CaseService`. (Dashboard/chart imports updated accordingly.)

### 6.4 Components

**Field Officer tree:**
- `OfficerCaseListComponent` — ag-grid of the officer's own cases (reuses the dashboard grid pattern + `onGridReady`/`sizeColumnsToFit`, quick filter). Row click → `officer/cases/:ref`. "New case" button → `officer/cases/new`. Column defs from the new `CASE_COLUMNS` (§6.5).
- `OfficerCaseFormComponent` — handles both create and edit/resubmit (route param `:ref` optional). Sub-sections rendered as child components:
  - `CaseDetailsFormComponent` — customer/site fields; disabled unless status ∈ {Draft, Needs Correction}.
  - `PhotoUploadComponent` — file input → `UploadService.uploadImage` → `CaseService.attachPhoto`; thumbnail list with caption/category and delete.
  - `DocumentUploadComponent` — file input (image/PDF) + `document_type` `<select>` (the 4 allowed types) → `UploadService.uploadDocument` → `CaseService.attachDocument`; list with type + delete.
  - `GpsCaptureComponent` — "Capture location" button (Geolocation API), manual lat/long fallback inputs, shows resolved `gps_status`; calls `CaseService.setGps`.
  - `AiResultsViewComponent` — read-only render of `ai_results` after submit (shared with review screen); null-guards every nested field, shows "OCR not available" when `ocrText` is null.
  - Submit button → `CaseService.submit`; on `Needs Correction` the form shows a prominent **correction banner** displaying `reviewComment`/`reviewer`, enables editing, and the button reads "Resubmit".

**Front Office tree:**
- `ReviewQueueComponent` — ag-grid list filtered to `status=Submitted` (reuses grid + `CASE_COLUMNS`); row click → `office/review/:ref`.
- `CaseReviewComponent` — read-only `CaseDetail` view: details, `PhotoGalleryComponent` (reuses image URL resolution), documents list (link/open), GPS block (lat/long + status; no map rendering — out of scope), and `AiResultsViewComponent`. Action bar: **Approve** / **Reject** / **Request correction**, each opening a comment box; reject & request-correction require a non-empty comment (client-side guard mirrors server 422). Calls the matching `CaseService` method, then routes back to the queue.
- `CompletedCasesComponent` — ag-grid filtered to `status=Completed`.
- `OverviewComponent` — KPI cards from `CaseService.getStats()` + the repurposed `PMRChartComponent`.

**Reused shared components:**
- `PMRChartComponent` — reused; update `OrderStatus` union and `COLORS`/`STATUS_ORDER` to the canonical case statuses (`Draft`, `Submitted`, `Needs Correction`, `Rejected`, `Completed`) and read from the repurposed chart service.
- `StatusButtonRendererComponent` — reused; extend the status→class map to the new statuses (`Draft`→secondary, `Submitted`→primary, `Needs Correction`→warning, `Completed`→success, `Rejected`→danger).
- `CustomFilterComponent` — kept as-is (generic ag-grid filter).

**Deleted components:** `LabelingComponent` (`labeling/*`) — the canvas bbox labeling UI is dropped (not genuinely reused; the open editor file `labeling.component.html` is removed with it). `DashboardComponent` is **repurposed/removed**: its grid pattern is lifted into `OfficerCaseListComponent`/`ReviewQueueComponent`; the standalone `dashboard` route is removed. `SignupComponent` is **kept and wired to real registration with a role picker** (see below) — no longer a local stub.

`SignupComponent` is **wired to real registration** (confirmed requirement): it POSTs to `${environment.apiUrl}/auth/register` via `AuthService.register(name, email, password, role)` and includes a role `<select>` offering `field_officer` and `front_office` (admin is seeded, not offered in signup). On success it stores the returned token/role (TokenResponse) and routes via `auth.homeRoute()`, or redirects to `/login`. `RegisterRequest.role` on the backend already accepts the role string; its default becomes `"field_officer"`.

`app.component.ts` top nav: replace `goHome()` target `/dashboard` with `auth.homeRoute()`; show nav links appropriate to the stored role (officer: My Cases / New; front office: Review Queue / Completed / Overview). `logout()` unchanged (also clears role via AuthService).

### 6.5 ag-grid column defs (`config/case-columns.ts`, replacing `order-columns.ts`)

```typescript
export const CASE_COLUMNS: ColDef[] = [
  { field: 'caseRef',        headerName: 'Case Ref',  filter: 'agTextColumnFilter' },
  { field: 'customerName',   headerName: 'Customer',  flex: 1 },
  { field: 'siteId',         headerName: 'Site ID',   flex: 1 },
  {
    field: 'status', headerName: 'Status', flex: 1,
    filter: 'agSetColumnFilter',
    filterParams: {
      values: ['Draft', 'Submitted', 'Needs Correction', 'Rejected', 'Completed'],
      suppressMiniFilter: true,
    },
    cellRenderer: StatusButtonRendererComponent,
  },
  { field: 'assignedOfficer', headerName: 'Officer',    flex: 1 },
  { field: 'capturedAt',      headerName: 'Captured At', flex: 1 },
];
```

The set-filter lists exactly the canonical statuses (FR-13.2) — `Approved` is intentionally excluded because it is never a stored `status` (it lives in `reviewDecision`); `Completed` is the visible terminal approved state.

---

## 7. `main.py` wiring + CORS

- Imports: `from routers import auth, uploads, verification` (drop `orders`, `yolo`).
- Registration: `app.include_router(auth.router)`, `uploads.router`, `verification.router` (drop orders/yolo).
- `app.mount("/uploads", StaticFiles(...))` — unchanged.
- CORS — unchanged: `allow_origins=["http://localhost:4200","http://localhost:4201"]`, credentials/methods/headers as-is.
- Title/description/version strings updated to "Field Site Verification API" (cosmetic). `startup()` still calls `create_tables()`.

---

## 8. `seed.py` changes + DB reset

Because the schema changed, the SQLite DB must be reset. **DB-reset instruction (document in seed.py header and task notes):**

```
cd backend
rm -f pmr_dashboard.db
.venv/bin/python seed.py
```

(`create_tables()` runs inside `seed.py`, so deleting the file and re-seeding yields a fresh schema. Equivalent: drop all tables via `Base.metadata.drop_all(engine)` at the top of seed — the design uses the explicit `rm` for clarity since the file is local SQLite.)

Keep the bcrypt `hash_password` fallback **exactly as-is** (passlib → bcrypt direct). Replace the users/orders seeding:

- **Users** (password `pwd`): one `admin`, two `field_officer` (e.g. `Fatima Noor` / `officer@example.com`, `Ali Raza` / `officer2@example.com`), one `front_office` (`Review Desk` / `office@example.com`). Print demo credentials as today.
- **Clear** `AIValidationResult`, `CaseDocument`, `CasePhoto`, `VerificationCase`, `ActivityLog`, `User` (delete children before parents to respect FKs).
- **Cases spanning every status** (NFR-6): create ≥6 cases assigned to the officers covering `Draft`, `Submitted`, `Needs Correction`, `Rejected`, `Completed`. Reuse the existing uploaded images in `backend/uploads/*.jpg` as `CasePhoto.url` values (`/uploads/<existing>.jpg`) so review screens show real images; add 1–2 `CaseDocument` rows. Spread `created_at` across recent months (keep the existing month-spread trick so the overview chart is populated).
- **AI results**: for at least the `Submitted` and reviewed (`Completed`/`Rejected`/`Needs Correction`) cases, insert `AIValidationResult` rows directly (seed can call `services.ai_validation.validate_case` on the seeded photo paths, or write static representative rows — the design prefers calling the service so seed data matches live output). Set `captured_at`, `review_decision`/`reviewer`/`review_comment`/`reviewed_at` on reviewed cases.
- **Activity log**: a handful of entries referencing the new case refs (`VC001` created, submitted, approved, etc.).

---

## 9. Edge cases & error handling (per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| create case | duplicate `case_ref` | recoverable | 409 | no (expected) |
| create/update | missing/oversize fields | recoverable | 422 (pydantic) | no |
| update/attach/gps on wrong status | status ∉ {Draft,Needs Correction} | recoverable | 409 with detail | no |
| any case op by non-owner officer | ownership mismatch | fatal for caller | 403 | no |
| officer calls approve/reject/correction | role check | fatal for caller | 403 | no |
| front office edits/submits officer case | role check (`require_field_officer`) | fatal for caller | 403 | no |
| submit with no photos | min-content check | recoverable | 422 (`"At least one photo required"`) | no |
| submit on terminal/invalid status | transition check | recoverable | 409 | no |
| AI per-asset error (unreadable image) | Pillow open fails | handled | result row with `pass=False`, note; case still Submitted | activity `warning` |
| AI YOLO load/inference error | ultralytics/torch error | handled | objects fall back to heuristic, note set | not fatal |
| AI catastrophic error | unexpected exception in `validate_case` | handled by router | one aggregate error result row; case still Submitted | activity `error` |
| reject/correction empty comment | comment check | recoverable | 422 | no |
| upload wrong type | ext/MIME not allowed | recoverable | 415 | no |
| upload empty / oversize | size check | recoverable | 400 / 413 | no |
| GPS out-of-range | lat/long bounds | recoverable | 422 | no |
| get/act on missing case | not found | recoverable | 404 | no |
| delete case by non-admin | role check | fatal for caller | 403 | no |

**Invariant ownership:** the router layer owns ownership + transition enforcement (not the ORM), because it has the authenticated `current` user and the HTTP status vocabulary; the schema layer owns input shape/range validation; the DB owns uniqueness (`case_ref`) and FK integrity. This split keeps each rule at the layer with the right context and makes the status/transition logic unit-testable via TestClient.

**Frontend null-guarding (NFR-3):** every `CaseService` mapper uses `?? ''` / `?? null` / `Array.isArray(...)`; `AiResultsViewComponent` treats every AI field as possibly null; `PhotoGalleryComponent` tolerates empty arrays.

---

## 10. Verification plan (maps to NFR-5)

- `backend/.venv/bin/python -c "import models"` and `-c "import main"` exit 0 (shim sync check).
- `cd backend && .venv/bin/python seed.py` after `rm -f pmr_dashboard.db` seeds cleanly; login with `pwd` works for the demo officer and front-office users.
- `uvicorn main:app --port 8000` starts; `/docs` lists the new `/cases/*` + `/uploads/document` routes and no `/orders`/`/detect` routes.
- Backend unit tests (new `backend/tests/`): `validate_case` on a fixture image (real Pillow path) and on a forced-YOLO-failure (fallback path); TestClient integration for the full state machine (create→attach→submit→approve/reject/correction→resubmit) and the 403/409/422 cases in §9.
- `npx ng build --configuration development` passes with zero TS/template errors.
- Clean up any temp fixtures created during testing.

---

## Technology choices made (not left to the implementer)

1. **Status storage:** plain `String` + module constant tuple + router-enforced transition map (not a DB enum) — matches existing `order_status` style and keeps SQLite migration-free.
2. **`photo_quality_score` range:** 0..1 float, pass threshold 0.5.
3. **Documents:** a dedicated `POST /uploads/document` with a widened allow-set (images + PDF) rather than loosening the strict image endpoints.
4. **Approved vs Completed:** approve writes `status="Completed"` + `review_decision="Approved"` in one call; `Approved` is never a stored status (A2).
5. **AI object detection (locked):** reuse the real YOLOv8 model (`yolov8n.pt`/ultralytics, confirmed importable) folded into the AI service for the required-objects/equipment check — not a heuristic. The fallback runs only on model/runtime failure (resilience for FR-7.5); `required_objects_pass = all expected objects present`.
6. **OCR:** explicit stub (`null` text/fields, provenance note) — no OCR dependency added.
7. **Admin:** reuses `require_admin` for deletes/user-management and is treated as a superset of both operational roles in `require_field_officer`/`require_front_office`.
8. **Frontend data layer:** one `CaseService` + one `UploadService`; `OrderService`/`DetectionService`/`LabelingService` deleted; `StatusChartService`/`PMRChartComponent`/`StatusButtonRendererComponent`/`CustomFilterComponent` repurposed; `LabelingComponent`/`DashboardComponent` removed.
