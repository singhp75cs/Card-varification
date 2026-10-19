# Implementation Plan — Field Site Verification Workflow

This plan transforms the existing PMR image-labeling app into a Field Site Verification
workflow by editing the EXISTING repo-root files directly and **in place**. It implements
`design.md` sections 1–10 and satisfies `requirements.md`.

## Hard constraints (must hold for every step)

- **IN-PLACE ONLY (CL-3).** All work happens directly under
  `/Users/irfan/Downloads/DashBoard-GenAI-master/src` and
  `/Users/irfan/Downloads/DashBoard-GenAI-master/backend` on the current branch.
  Do **NOT** create a git worktree, a `.worktrees` directory, a second/parallel/duplicate
  project, or a second `src` tree. The design.md phrase "this worktree" is stale — read it
  as "the existing repo-root project, in place". If `/Users/irfan/Downloads/DashBoard-GenAI-master/.worktrees`
  ever appears, that is a defect: delete it and continue in place.
- **NO GIT WRITES (user hard constraint, whole run).** Do **NOT** `git push`, open a PR/MR,
  do any remote git operation, create branches, merge, rebase, or create commits. Only modify
  the local working-tree files in place and leave them uncommitted for the user to review.
  Nothing may leave the local machine. Local, non-git verification (resetting/seeding the
  local SQLite DB, running a local `uvicorn` server for curl tests, running `ng build`) is fine.
- **NO NEW PACKAGES (NFR-1).** Do not add any Python package to `backend/requirements.txt` or
  any npm package to `package.json`. Pillow 10.3.0 and ultralytics 8.3.40 are already present
  in `backend/.venv` and are used as-is.
- **YOLO IS REAL (CL-1 / FR-7, locked).** The required-objects/equipment check MUST run the
  real YOLOv8 model (`backend/yolov8n.pt` via ultralytics), folded into the AI validation
  service. The heuristic/fallback runs ONLY if model load/inference raises (FR-7.5) — never on
  the happy path.
- **ROLES (CL-2).** Roles are `field_officer` / `front_office` / `admin`. Signup lets a user
  pick `field_officer` or `front_office`; `admin` is seeded only. Route by role after login.

## Toolchain / commands (discovered during exploration)

- Backend interpreter: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/.venv/bin/python`
  (confirmed to exist; Pillow 10.3.0 + ultralytics 8.3.40 importable per design).
- Backend run dir for imports/seed/uvicorn: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend`
  (the modules use flat imports like `from database import ...`, so commands must run with CWD
  = `backend`).
- Local SQLite DB file: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/pmr_dashboard.db`.
- Frontend build: Angular 22 (`@angular/core ^22.0.0`). Use Node via nvm:
  `nvm use 22.23.3` then `npx ng build --configuration development` from
  `/Users/irfan/Downloads/DashBoard-GenAI-master`.
- There is no `backend/tests/` directory yet; step 16 creates it. No pytest config exists, so
  tests are run with the venv python directly (`.venv/bin/python -m pytest` if pytest is present,
  otherwise plain `.venv/bin/python backend/tests/<file>.py` self-asserting scripts — the coder
  verifies which is available during step 16 and documents the choice; do NOT add pytest to
  requirements.txt if it is absent — fall back to runnable assertion scripts).

> Ordering note: steps are ordered by dependency. The backend data layer (1–3) must land before
> routers (4–6); the AI service (5) is imported by the verification router (4) and by seed (7);
> the DB reset+seed (7) depends on the full backend compiling. The frontend (8–14) depends only
> on the backend contract (paths/shapes), so it may be done in parallel with backend verification
> but is listed after. Each step leaves the tree importable/buildable as noted.

---

# Backend

- [ ] 1. Rewrite the ORM layer in `backend/database.py`: delete `Order` and `Detection`; repurpose `User`; add the verification domain classes and status constants.
      Keep the module docstring style, `datetime.utcnow` defaults, and the
      `relationship(..., cascade="all, delete-orphan")` pattern. Add `JSON` to the
      `sqlalchemy` import line. Changes (design §1):
      - Module-level constants: `CASE_STATUSES = ("Draft","Submitted","Approved","Rejected","Needs Correction","Completed")`,
        `REVIEW_DECISIONS = ("Approved","Rejected","Needs Correction")`,
        `DOCUMENT_TYPES = ("ID","Utility Bill","Agreement","Other")`,
        `GPS_STATUSES = ("captured","manual","unavailable")`.
      - `User`: change `role` default from `"labeler"` to `"field_officer"` (type stays
        `String(20)`, comment `field_officer | front_office | admin`); replace the
        `orders` relationship with `cases = relationship("VerificationCase", back_populates="officer")`.
      - Delete classes `Order` and `Detection` entirely.
      - Add `VerificationCase` (table `verification_cases`) with the exact columns in design §1.3
        (`case_ref` unique+index default via router; `status` default `"Draft"`; `customer_name`,
        `site_address` required; `site_id`, `contact`, `verification_type` nullable; `notes` Text
        default `""`; `latitude`/`longitude` Float nullable; `gps_status` String(20) default
        `"unavailable"`; `captured_at` DateTime nullable; `officer_id` FK users.id not null;
        `review_decision`/`reviewer`/`review_comment`/`reviewed_at` nullable; `created_at` utcnow;
        `updated_at` utcnow + onupdate utcnow). Relationships: `officer` (back_populates `cases`),
        `photos`/`documents`/`ai_results` each `cascade="all, delete-orphan"`.
      - Add `CasePhoto` (table `case_photos`), `CaseDocument` (table `case_documents`),
        `AIValidationResult` (table `ai_validation_results`) exactly per design §1.4/§1.5/§1.6,
        including the nullable `photo_id`/`document_id` FKs and `JSON`-typed
        `required_objects`/`extracted_fields`. Keep `get_db` and `create_tables` unchanged.
      - Update the top-of-file comment that lists tables.
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/database.py`
      Verify: deferred to step 3's combined smoke check (this file alone won't import cleanly
      until the shims in step 3 match). Do not run a standalone import here.

- [ ] 2. Rewrite the Pydantic schemas in `backend/schemas.py`: drop all Order/Detection/Yolo/DashboardStats schemas; add the case schema set.
      Keep `from __future__ import annotations`, section-comment style, and
      `model_config = {"from_attributes": True}` on every response model. Changes (design §2):
      - Keep `RegisterRequest` (change `role` default to `"field_officer"`), `LoginRequest`,
        `TokenResponse` (already has `user_role` — leave as-is), `UserOut`, `ActivityOut`,
        `UploadResult`.
      - Delete `DetectionBox`, `DetectionOut`, `LabelBoxIn`, `OrderCreate`, `OrderUpdate`,
        `OrderOut`, `DashboardStats`, `YoloResult`.
      - Add request schemas: `CaseCreate`, `CaseUpdate`, `GpsUpdate` (with `field_validator`
        `gps_status ∈ GPS_STATUSES` and a `model_validator(mode="after")` enforcing coord
        consistency — both present unless `unavailable`, else both null), `PhotoAttach`,
        `DocumentAttach` (with `field_validator` `document_type ∈ DOCUMENT_TYPES`), `ReviewAction`.
        Import the constants used by validators from `database` (e.g.
        `from database import GPS_STATUSES, DOCUMENT_TYPES`), or inline tuples matching them —
        prefer importing from `database` to keep one source of truth.
      - Add response schemas: `PhotoOut`, `DocumentOut`, `AIResultOut`, `CaseOut`
        (includes `assigned_officer: Optional[str] = None`), `CaseDetailOut(CaseOut)` with
        `photos`/`documents`/`ai_results` lists, `CaseStats` (fields `total`, `draft`,
        `submitted`, `needs_correction`, `rejected`, `completed`). Use field types exactly as
        design §2.2/§2.3 (e.g. `required_objects: Optional[list[dict]]`,
        `extracted_fields: Optional[dict]`).
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/schemas.py`
      Verify: deferred to step 3's combined smoke check.

- [ ] 3. Update the three `models/*` re-export shims in lockstep so `import models` succeeds.
      Remove `Order`, `Detection` and all `Detection*`/`Order*`/`Yolo*`/`DashboardStats`
      symbols; add the new ORM classes and schema names. Keep `Base, engine, SessionLocal, User,
      ActivityLog, get_db, create_tables`. Keep auth/upload/activity schemas. Update BOTH the
      `from ... import (...)` lists AND the `__all__` lists in all three files so they match
      exactly (design §1.7). Add the new case ORM classes
      (`VerificationCase, CasePhoto, CaseDocument, AIValidationResult`) to `models/orm.py` and
      `models/__init__.py`; optionally re-export the new constants. Add the new schema names
      (`CaseCreate, CaseUpdate, GpsUpdate, PhotoAttach, DocumentAttach, ReviewAction, PhotoOut,
      DocumentOut, AIResultOut, CaseOut, CaseDetailOut, CaseStats`) to `models/schemas.py` and
      `models/__init__.py`. Update the illustrative docstring import examples so they reference
      the new symbols instead of `Order`/`Detection`/`YoloResult`.
      Files:
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/models/orm.py`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/models/schemas.py`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/models/__init__.py`
      Verify (steps 1–3 together):
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "import database, schemas, models"`
      exits 0 with no ImportError (the `__all__`/import-list mismatch enforcement from design §1.7).

- [ ] 4. Create the AI validation service `backend/services/ai_validation.py` (new `backend/services/` package).
      This comes before the verification router because the router imports it. Create
      `backend/services/__init__.py` (empty or a one-line docstring) and `ai_validation.py` with
      (design §4):
      - Module constants `PHOTO_QUALITY_PASS_THRESHOLD = 0.5` and
        `REQUIRED_OBJECTS = ["building", "signage", "meter"]`.
      - `@dataclass AssetRef(kind, asset_id, local_path, original_name, content_type)`.
      - A lazy YOLO loader moved **verbatim** from `backend/routers/yolo.py`: copy
        `_allow_ultralytics_globals()`, the module-level `_model = None`, `YOLO_MODEL` env read,
        and a `get_model()` that does `_allow_ultralytics_globals(); from ultralytics import YOLO;
        _model = YOLO(YOLO_MODEL)`. (This is the REAL object-presence path — CL-1.)
      - `validate_case(photos: list[AssetRef], documents: list[AssetRef]) -> list[dict]` that
        returns `AIValidationResult`-shaped dicts. Per design §4.2/§4.3:
        * **Photo quality — REAL (Pillow):** open each photo with `PIL.Image`, compute a 0..1
          score from brightness/contrast + a Laplacian-like sharpness proxy; `pass = score >= 0.5`.
          On unreadable image → `photo_quality_score=0.0, photo_quality_pass=False,
          note="photo-quality: unreadable image"`.
        * **Required objects — REAL YOLO:** run `get_model()` detection per photo; map detected
          class names (case-insensitive against `result.names`) onto `REQUIRED_OBJECTS` presence;
          `required_objects_pass = all(present)`. Wrap model load/inference in `try/except`: on
          error, set every object `present=False` and
          `note="objects: yolo-unavailable (<err>), fallback"` (resilience only — FR-7.5).
        * One result dict **per photo** (photo_id set; photo_quality_* + required_objects* filled;
          doc fields null) and one **per document** (document_id set; document_type_* HEURISTIC
          from officer-selected `document_type` cross-checked with filename/ext/content-type:
          confidence 1.0 on match else ~0.5; `ocr_text=None`, `extracted_fields=None` STUB).
        * `note` is a semicolon-joined provenance string, e.g.
          `"photo-quality:real; objects:yolo; ocr:stub"`.
        * If zero photos and zero documents, return one dict with `note="no assets"`.
        * Never raise for a single-asset failure (capture into that asset's row). Document every
          stub/real/heuristic boundary in code comments (FR-7.4).
      Files:
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/services/__init__.py`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/services/ai_validation.py`
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "from services.ai_validation import validate_case, AssetRef, REQUIRED_OBJECTS; print(validate_case([], []))"`
      exits 0 and prints a single-dict list with `note="no assets"`.

- [ ] 5. Add the two role dependencies to `backend/routers/auth.py` (no other logic changes).
      Next to `require_admin`, add `require_field_officer` and `require_front_office` exactly per
      design §3.0 (admin allowed through both; `field_officer` only through
      `require_field_officer`, `front_office` only through `require_front_office`, else 403).
      Leave register/login/token/me/users and all hashing/JWT logic untouched.
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/routers/auth.py`
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "from routers.auth import require_field_officer, require_front_office, require_admin"`
      exits 0.

- [ ] 6. Extend `backend/routers/uploads.py` with a documents endpoint; keep all image guardrails.
      Per design §3.1: add `ALLOWED_DOC_EXT = ALLOWED_EXT | {".pdf"}` and
      `ALLOWED_DOC_MIME = ALLOWED_MIME | {"application/pdf"}`. Refactor `_safe_ext` and `_store`
      to accept `allowed_ext`/`allowed_mime` arguments defaulting to the image sets (so existing
      `/uploads` and `/uploads/single` callers are unchanged). Add
      `POST /uploads/document` (any authenticated user) that calls `_store(file, ALLOWED_DOC_EXT,
      ALLOWED_DOC_MIME)` and returns `UploadResult`. Keep 415 (bad type/ext), 400 (empty), 413
      (oversize), the random stored name, and the path-traversal-safe delete.
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/routers/uploads.py`
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "from routers.uploads import router; print([r.path for r in router.routes])"`
      exits 0 and lists `/uploads/document`.

- [ ] 7. Create the verification router `backend/routers/verification.py` (prefix `/cases`), replacing `routers/orders.py`.
      Model it on `orders.py`'s structure (copy the `_log` helper verbatim). Import the new ORM
      classes/schemas and the role deps. Implement all endpoints and logic in design §3.2/§3.3
      exactly. Helpers: `_get_case_or_404(db, case_ref)`, `_require_owner(case, current)` (403 if
      `current.role == "field_officer"` and `case.officer_id != current.id`),
      `_next_case_ref(db)` (`"VC%03d"` from max numeric suffix, 409-safe), and
      `_to_case_out(case)` / detail mapper that sets `assigned_officer = case.officer.name if
      case.officer else None`. Endpoints (authorization + status gates per the §3.2 table):
      `POST /cases`, `GET /cases` (field_officer forced to own cases; `status`/`q`/`mine`/`skip`/
      `limit` filters), `GET /cases/stats` (CaseStats; `completed` counted by status),
      `GET /cases/activity`, `GET /cases/{ref}`, `PUT /cases/{ref}`,
      `POST /cases/{ref}/photos`, `DELETE /cases/{ref}/photos/{photo_id}`,
      `POST /cases/{ref}/documents`, `DELETE /cases/{ref}/documents/{doc_id}`,
      `PUT /cases/{ref}/gps`, `POST /cases/{ref}/submit`, `POST /cases/{ref}/approve`,
      `POST /cases/{ref}/reject`, `POST /cases/{ref}/request-correction`,
      `DELETE /cases/{ref}` (require_admin). Enforce the status-transition table (409 on illegal
      transition), min-content on submit (≥1 photo else 422 `"At least one photo is required
      before submitting"`), server-side `captured_at` at submit, and non-empty comment (422) for
      reject/request-correction. On submit/resubmit: delete prior `AIValidationResult` rows,
      resolve each `CasePhoto.url`/`CaseDocument.url` to `UPLOAD_DIR / Path(url).name`, build
      `AssetRef`s, call `services.ai_validation.validate_case` inside `try/except`; on exception
      persist one aggregate error row (`photo_quality_pass=False, required_objects_pass=False,
      note="ai-error: <msg>"`) and still transition to `Submitted` (FR-7.5). Log activity with the
      right severity (approve→success, reject→error, correction→warning).
      Then **delete** `backend/routers/orders.py` and `backend/routers/yolo.py` (their
      functionality is replaced; the YOLO weights file and loader logic now live in the AI
      service — do NOT delete `backend/yolov8n.pt`).
      Files: create `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/routers/verification.py`;
      delete `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/routers/orders.py` and
      `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/routers/yolo.py`
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "from routers.verification import router; print(sorted({r.path for r in router.routes}))"`
      exits 0 and lists the `/cases*` paths.

- [ ] 8. Rewire `backend/main.py`: register the new routers, drop the deleted ones, update cosmetic strings.
      Per design §7: change the import to `from routers import auth, uploads, verification`
      (drop `orders`, `yolo`); register `auth.router`, `uploads.router`, `verification.router`
      (drop orders/yolo). Keep the `/uploads` static mount, CORS for :4200/:4201, and the
      `startup()`→`create_tables()` call. Update `title`/`description`/`version`/root-message
      strings to "Field Site Verification API".
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/main.py`
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c "import main"`
      exits 0 (NFR-5). This confirms steps 1–8 all import together.

- [ ] 9. Rewrite `backend/seed.py` for the verification domain and document the DB-reset procedure.
      Per design §8 and NFR-6. Keep the `hash_password` bcrypt fallback EXACTLY as-is (passlib
      first, direct `bcrypt.hashpw` fallback) — this is the known passlib+bcrypt issue path and
      the direct-bcrypt fallback must be the hash path that actually runs. Add a header comment
      documenting the reset procedure (`rm -f pmr_dashboard.db` then
      `.venv/bin/python seed.py`) and the no-git constraint. Replace seeding:
      - Clear children before parents: `AIValidationResult`, `CaseDocument`, `CasePhoto`,
        `VerificationCase`, `ActivityLog`, `User`.
      - Users (password `pwd`): one `admin`, two `field_officer`
        (`Fatima Noor`/`officer@example.com`, `Ali Raza`/`officer2@example.com`), one
        `front_office` (`Review Desk`/`office@example.com`). Print demo credentials.
      - ≥6 `VerificationCase` rows (`VC001`…) assigned to the officers covering every status
        (`Draft`, `Submitted`, `Needs Correction`, `Rejected`, `Completed`). Use existing images
        in `backend/uploads/*.jpg` as `CasePhoto.url` values (`/uploads/<existing>.jpg`); add 1–2
        `CaseDocument` rows. Spread `created_at` across recent months (keep the month-spread trick
        so the overview chart populates). Set `captured_at` and
        `review_decision`/`reviewer`/`review_comment`/`reviewed_at` on reviewed cases.
      - AI results: for the `Submitted`/reviewed cases, insert `AIValidationResult` rows —
        preferably by calling `services.ai_validation.validate_case` on the seeded photo paths so
        seed data matches live output (fall back to representative static rows only if the model
        is unavailable in the seed environment).
      - Activity log: a handful of entries referencing the new case refs.
      Files: `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/seed.py`
      Verify (DB reset + reseed):
      `rm -f /Users/irfan/Downloads/DashBoard-GenAI-master/backend/pmr_dashboard.db && cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python seed.py`
      exits 0, prints the created users/cases, and the DB file is recreated. (The schema changed,
      so the old DB MUST be deleted first.)

---

# Frontend (Angular)

> The frontend depends only on the backend contract (route paths + JSON shapes), which steps
> 1–9 fix. Keep the existing service patterns: `private apiUrl = environment.apiUrl`,
> `authHeaders()` Bearer helper, snake→camel mapping with `?? ''` / `Array.isArray(...)`
> null-guards (NFR-3/NFR-4). No hardcoded URLs.

- [ ] 10. Update `AuthService` to store the role and compute the home route; wire the role guard.
      Per design §6.1/§6.2:
      - `auth.service.ts`: in `login()`'s `map`, also read `res.user_role` and
        `localStorage.setItem('role', res.user_role)` (widen the response type to include
        `user_role`). The mock-fallback branch sets a default role (`'field_officer'` if none in
        `auth.json`). Add `getRole(): string | null` and `homeRoute(): string` (`/officer/cases`
        for `field_officer`, `/office/review` for `front_office`/`admin`, `/login` if unknown).
        `logout()` also removes `'role'`.
      - `auth.guard.ts`: keep `authGuard`; add
        `export const roleGuard = (allowed: string[]): CanActivateFn => () => {...}` that reads
        `auth.getRole()` and redirects to `auth.homeRoute()` when not allowed (design §6.1).
      Files:
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/auth/auth.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/auth/auth.guard.ts`
      Verify: covered by the step 23 `ng build` (no isolated build for a single TS file).

- [ ] 11. Create `CaseService` and `UploadService`; delete `OrderService`, `DetectionService`, `LabelingService`.
      Per design §6.3:
      - `services/case.service.ts`: central data service mirroring `order.service.ts`
        (apiUrl, `authHeaders()`, snake→camel mapping, null-guards). Methods: `list(filter?)`,
        `getStats()`, `getActivity()`, `get(ref)`, `create(body)`, `update(ref, body)`,
        `attachPhoto(ref, body)`, `deletePhoto(ref, id)`, `attachDocument(ref, body)`,
        `deleteDocument(ref, id)`, `setGps(ref, body)`, `submit(ref)`, `approve(ref, comment)`,
        `reject(ref, comment)`, `requestCorrection(ref, comment)` — all hitting `/cases*`.
        Define camelCase TS interfaces `Case`, `CaseDetail`, `Photo`, `Document`, `AIResult`
        matching design §2.3, every field null-guarded on read.
      - `services/upload.service.ts`: extract the reusable upload logic from
        `labeling.service.ts`: `uploadImage(file)` → `POST /uploads/single`,
        `uploadDocument(file)` → `POST /uploads/document`; keep the `${apiUrl}${url}` absolute-URL
        resolution and `authHeaders()`. Return `{ url, originalName, contentType, size }`.
      - Delete `services/order.service.ts`, `services/detection.service.ts`,
        `services/labeling.service.ts` and their `.spec.ts` siblings
        (`order.service.spec.ts`, `labeling.service.spec.ts`).
      Files: create
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/case.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/upload.service.ts`;
      delete `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/order.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/order.service.spec.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/detection.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/labeling.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/labeling.service.spec.ts`
      Verify: covered by step 23 `ng build`.

- [ ] 12. Add `CASE_COLUMNS` (`config/case-columns.ts`), repurpose `StatusChartService`, `PMRChartComponent`, and `StatusButtonRendererComponent`; delete `order-columns.ts`.
      Per design §6.3/§6.5 and §6.4 "reused shared components":
      - Create `config/case-columns.ts` with `CASE_COLUMNS` exactly per design §6.5 (`caseRef`,
        `customerName`, `siteId`, `status` with set-filter values
        `['Draft','Submitted','Needs Correction','Rejected','Completed']` + the status renderer,
        `assignedOfficer`, `capturedAt`). Delete `config/order-columns.ts`.
      - `status-chart.service.ts`: rename/point `getOrders()` → `getCases()` reading `/cases`,
        mapping `status`/`created_at` to the chart shape (bucket by the new statuses).
      - `pmr-chart.component.ts`: change the `OrderStatus` union, `COLORS`, and `STATUS_ORDER`
        to the canonical case statuses (`Draft`, `Submitted`, `Needs Correction`, `Rejected`,
        `Completed`) and read from the repurposed chart service method.
      - `status-button-renderer.component.ts`: extend the status→class map
        (`Draft`→secondary, `Submitted`→primary, `Needs Correction`→warning, `Completed`→success,
        `Rejected`→danger).
      Files: create
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/config/case-columns.ts`;
      delete `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/config/order-columns.ts`;
      modify `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/services/status-chart.service.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/pmr-chart/pmr-chart.component.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/shared/status-button-renderer/status-button-renderer.component.ts`
      Verify: covered by step 23 `ng build`.

- [ ] 13. Build the Field Officer component tree.
      Per design §6.4. Create standalone components under `src/app/officer/`:
      - `OfficerCaseListComponent` — ag-grid of the officer's own cases (reuse the dashboard grid
        pattern: `onGridReady`/`sizeColumnsToFit`, quick filter, `CASE_COLUMNS`); row click →
        `officer/cases/:ref`; "New case" → `officer/cases/new`.
      - `OfficerCaseFormComponent` — handles create and edit/resubmit (optional `:ref` param);
        shows a correction banner (`reviewComment`/`reviewer`) and a "Resubmit" button when status
        is `Needs Correction`; submit → `CaseService.submit`. Composes the child components:
        `CaseDetailsFormComponent` (customer/site fields; disabled unless status ∈ {Draft,
        Needs Correction}), `PhotoUploadComponent` (file → `UploadService.uploadImage` →
        `CaseService.attachPhoto`; thumbnails + caption/category + delete),
        `DocumentUploadComponent` (image/PDF + `document_type` `<select>` of the 4 allowed types →
        `UploadService.uploadDocument` → `CaseService.attachDocument`; list + delete),
        `GpsCaptureComponent` (Geolocation API + manual lat/long fallback → `CaseService.setGps`;
        shows resolved `gps_status`), and the shared `AiResultsViewComponent` (read-only, null-
        guards every nested field, shows "OCR not available" when `ocrText` is null).
      All components standalone, strict-template clean, null-guard every backend read (NFR-3).
      Files (new, under
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/officer/` and a shared
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/shared/ai-results-view/`):
      component `.ts`/`.html`/`.scss` for `officer-case-list`, `officer-case-form`,
      `case-details-form`, `photo-upload`, `document-upload`, `gps-capture`, and shared
      `ai-results-view`.
      Verify: covered by step 23 `ng build`.

- [ ] 14. Build the Front Office component tree.
      Per design §6.4. Create standalone components under `src/app/office/`:
      - `ReviewQueueComponent` — ag-grid filtered to `status=Submitted` (reuses grid +
        `CASE_COLUMNS`); row click → `office/review/:ref`.
      - `CaseReviewComponent` — read-only `CaseDetail` view (details, photo gallery reusing the
        upload URL resolution, documents list, GPS block without map rendering, and the shared
        `AiResultsViewComponent`). Action bar Approve / Reject / Request correction, each opening a
        comment box; reject & request-correction require a non-empty comment (client guard
        mirroring server 422). Calls the matching `CaseService` method, then routes back to the
        queue.
      - `CompletedCasesComponent` — ag-grid filtered to `status=Completed`.
      - `OverviewComponent` — KPI cards from `CaseService.getStats()` + the repurposed
        `PMRChartComponent`.
      Reuse a `PhotoGalleryComponent` (shared) that tolerates empty arrays. Null-guard everything.
      Files (new, under
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/office/` plus shared
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/shared/photo-gallery/`):
      component `.ts`/`.html`/`.scss` for `review-queue`, `case-review`, `completed-cases`,
      `overview`, and shared `photo-gallery`.
      Verify: covered by step 23 `ng build`.

- [ ] 15. Rewrite routing, signup, login navigation, and top nav; delete `DashboardComponent` and `LabelingComponent`.
      Per design §6.1/§6.4:
      - `app.routes.ts`: replace the `dashboard`/`labeling` routes. Keep `login`/`signup` public.
        Add the `officer` subtree (`officer/cases`, `officer/cases/new`, `officer/cases/:ref`)
        guarded by `[authGuard, roleGuard(['field_officer','admin'])]` and the `office` subtree
        (`office/review`, `office/review/:ref`, `office/completed`, `office/overview`) guarded by
        `[authGuard, roleGuard(['front_office','admin'])]`. `''` and `**` → `/login`. Use
        `loadComponent` lazy imports like the existing routes.
      - `login-page.component.ts`: navigate to `this.auth.homeRoute()` instead of `/dashboard`;
        fix the success message to a plain `"Login successful"` string (the current
        `` `...Token: ${token}` `` interpolates an object — strict-template cleanup).
      - `signup.component.ts` (+ `.html`): wire to real registration via
        `AuthService.register(name, email, password, role)` POSTing to
        `${environment.apiUrl}/auth/register`; add a role `<select>` offering `field_officer` and
        `front_office` (not admin). On success store token/role and route via `auth.homeRoute()`
        (or redirect to `/login`). Add the `register(...)` method to `AuthService` returning the
        `TokenResponse` shape and storing token/username/role.
      - `app.component.ts` (+ `.html`): change `goHome()` to navigate to `auth.homeRoute()`;
        show role-appropriate nav links (officer: My Cases / New; front office: Review Queue /
        Completed / Overview). `logout()` unchanged (clears role via AuthService).
      - Delete the dashboard and labeling component trees (and their specs):
        `src/app/dashboard/*`, `src/app/labeling/*`.
      Files: modify
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/app.routes.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/login-page/login-page.component.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/signup/signup.component.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/signup/signup.component.html`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/auth/auth.service.ts` (add `register`),
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/app.component.ts`,
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/app.component.html`;
      delete `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/dashboard/` (all files) and
      `/Users/irfan/Downloads/DashBoard-GenAI-master/src/app/labeling/` (all files).
      Verify: covered by step 23 `ng build`.

---

# Verification (run after implementation; map to NFR-5 / §10)

- [ ] 16. Add backend tests for the AI service and the submit state machine.
      Create `backend/tests/` with (a) a unit test for `validate_case` on a tiny fixture image
      (real Pillow path) and on a forced-YOLO-failure (monkeypatch the lazy loader to raise →
      assert fallback note + `required_objects_pass=False`, no exception), and (b) a TestClient
      integration test for the full state machine (register/login officer → create → attach photo
      → submit → assert `Submitted` + `AIValidationResult` rows exist even when YOLO is forced to
      fail; front-office approve/reject/request-correction; resubmit from `Needs Correction`) and
      the 403/409/422 cases from design §9. First check whether pytest is importable in the venv
      (`.venv/bin/python -c "import pytest"`); if present use `pytest`, otherwise write the tests
      as self-asserting runnable scripts (do NOT add pytest to requirements.txt). Clean up any
      temp fixture files the tests create.
      Files (new): `/Users/irfan/Downloads/DashBoard-GenAI-master/backend/tests/` (test modules
      and a tiny fixture image or an in-test-generated one).
      Verify:
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -m pytest tests -q`
      (or run each script with `.venv/bin/python tests/<name>.py`) — all assertions pass.

- [ ] 17. Reset + reseed the local DB, start uvicorn, and record the full curl state-machine transcript.
      Run `rm -f /Users/irfan/Downloads/DashBoard-GenAI-master/backend/pmr_dashboard.db` then
      `.venv/bin/python seed.py`, then start the server locally
      (`cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -m uvicorn
      main:app --port 8000`, background). Using curl against `http://localhost:8000`, exercise and
      capture: login as the demo officer and front-office users (password `pwd`); create a case;
      save details; upload a photo via `/uploads/single` and attach it; attach a document via
      `/uploads/document`; set GPS (valid, and a 422 for latitude 100); submit (assert `Submitted`
      + AI result rows); front-office approve/reject/request-correction; resubmit; and the
      403/409/422 negative cases (officer calling approve → 403, approving a Draft → 409, reject
      with empty comment → 422, submit with no photos → 422). Confirm `/docs` lists `/cases*` and
      `/uploads/document` and NO `/orders`/`/detect` routes. Write the complete transcript
      (commands + responses + a short pass/fail summary mapped to the acceptance criteria) to
      `/Users/irfan/Downloads/DashBoard-GenAI-master/.agents/tasks/field-site-verification/verification.md`.
      Stop the uvicorn process when done. (Local only — no network egress, no git.)
      Files (new): `/Users/irfan/Downloads/DashBoard-GenAI-master/.agents/tasks/field-site-verification/verification.md`
      Verify: the transcript shows every state transition and negative case returning the expected
      status codes; the server started cleanly (NFR-5, acceptance 7–20, 23).

- [ ] 18. Build the frontend.
      Run `nvm use 22.23.3` then
      `cd /Users/irfan/Downloads/DashBoard-GenAI-master && npx ng build --configuration development`.
      Files: none (build only).
      Verify: the build completes with zero TS/template errors (NFR-5, acceptance 22). Fix any
      compile/strict-template errors surfaced by this build (they belong to steps 10–15) and
      re-run until green.

- [ ] 19. Final cleanup and in-place sanity check.
      Confirm no `/Users/irfan/Downloads/DashBoard-GenAI-master/.worktrees` directory and no
      duplicate `src`/project tree were created; remove any stray temp files from testing. Confirm
      no git commits/branches were created and nothing was pushed (the working tree is left
      modified and uncommitted for the user). Re-run the two headline checks once more as a final
      gate: `cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend && .venv/bin/python -c
      "import main, models"` exits 0, and the step 18 `ng build` is green.
      Files: none.
      Verify: both headline checks pass; `ls /Users/irfan/Downloads/DashBoard-GenAI-master/.worktrees`
      reports "No such file or directory".

---

## Notes / assumptions

- The known passlib(1.7.4)+bcrypt 72-byte issue is handled by `seed.py`'s existing direct-bcrypt
  fallback (kept verbatim in step 9) and the auth router's passlib `CryptContext` verify, which
  verifies a standard bcrypt hash either way. If passlib's bcrypt backend raises at seed time, the
  direct `bcrypt.hashpw` path runs — that is the intended hash path.
- `backend/yolov8n.pt` and the `YOLO_MODEL` env var are retained; the loader logic moves into the
  AI service (step 4). Deleting `yolo.py` must not delete the weights.
- If the YOLO model cannot load in the local environment at verification time, that is acceptable
  for FR-7.5 (the service records the fallback note and submission still succeeds) — but the coder
  should confirm ultralytics loads (`.venv/bin/python -c "from ultralytics import YOLO"`) so the
  REAL path (CL-1) is the one exercised on the happy path, and note the result in verification.md.
- Component file counts in steps 13/14 are illustrative; group each component's `.ts`/`.html`/
  `.scss` as one unit of work. Do not over-decompose.
