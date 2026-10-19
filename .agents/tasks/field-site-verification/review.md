# In-place rewrite: PMR labeling app → Field Site Verification workflow

The coder transformed the existing Angular 22 + FastAPI PMR image-labeling app into a Field Site Verification workflow by editing the repo-root `src/` and `backend/` trees in place. The backend swaps the `Order`/`Detection` domain for `VerificationCase`/`CasePhoto`/`CaseDocument`/`AIValidationResult`, adds a `/cases` router implementing the full Draft→Submitted→Approved(Completed)/Rejected/Needs Correction state machine with role-based authorization, and folds the real YOLOv8 model into a new AI validation service alongside Pillow photo-quality scoring, heuristic document typing, and stubbed OCR. The frontend replaces the dashboard/labeling screens with Field Officer (list/form/capture) and Front Office (review queue/case review/completed/overview) component trees, role-based routing with a `roleGuard`, and a null-guarding `CaseService`.

Watch for: nothing blocking. The in-place constraint is honored (confirmed — no `.worktrees`, no duplicate `src` or project), YOLO runs as the real happy path with heuristic only as a load/inference fallback (confirmed in `ai_validation.py` and the seed/curl evidence showing `objects:yolo` provenance), the model-import shims are in lockstep (confirmed — `import models` exits 0), and the verification evidence is complete with curl status codes, seed output, and a clean `ng build`.

**Verdict**: APPROVED

## High-level view

The hard in-place constraint is satisfied. There is no `.worktrees` directory, no second or parallel project, and no duplicate `src` tree — the only `src/app/app.routes.ts` is the real one (plus an unrelated node_modules template). All edits land in the existing `backend/` and `src/` trees, matching the user's single most-repeated demand.

The YOLO object-presence check is real (CL-1). `backend/services/ai_validation.py` lazy-loads `yolov8n.pt` via ultralytics exactly like the old `yolo.py::get_model` (same `_allow_ultralytics_globals()` guard), runs detection per photo, and maps detected class names onto `["building","signage","meter"]`. The `try/except` fallback marks all objects absent only when load/inference raises, with a distinct `yolo-unavailable` note — never on the happy path. The curl/seed evidence shows `note="photo-quality:real; objects:yolo"`, confirming the model actually ran.

Roles and the state machine match the design (CL-2). Roles are `field_officer`/`front_office`/`admin`; signup offers the two operational roles; `admin` is seeded only. `require_field_officer`/`require_front_office` gate the router (admin a superset of both), ownership is enforced for officers, and the status transitions reject illegal moves with 409 while reject/request-correction require a non-empty comment (422). The frontend routes by role via `homeRoute()` and `roleGuard`.

The data model, schemas, re-export shims, `/cases` router, `/uploads/document` endpoint, `main.py` rewiring, and seed/DB-reset all match design sections 1–10, and `import models` succeeds — proving the three shims and `__all__` lists are in sync.

The Angular route/screen/service map matches the design, every backend read is null-guarded in `CaseService` and the shared views, and no hardcoded API URLs appear in service code (all go through `environment.apiUrl`).

<details>
<summary>Issues (1)</summary>

1. **Non-prod placeholder in prod environment (non-blocking)** — `src/environments/environment.prod.ts` sets `apiUrl: 'http://localhost:8000'` and carries a stray `apiBaseUrl`. Harmless for this local review (NFR-4 only requires services read `environment.apiUrl`, which they do) but worth correcting before any real production build.

</details>

<details>
<summary>Details</summary>

### In-place constraint — honored

`ls .worktrees` returns "No such file or directory" and a workspace-wide search for `.worktrees` (including ignored files) finds nothing. The only `app.routes.ts` under `src/` is the real one; there is no second `src` tree outside `backend/.venv`. The verification evidence records HEAD still at the pre-existing commit with only working-tree modifications, consistent with the no-git-writes constraint. The diff does show `.agents/tasks/plan.md` modified — a stale tracked file at a different path than the `field-site-verification/` source-of-truth docs — which is a documentation artifact, not a second project or a code concern.

### YOLO is the real object-presence path (CL-1)

`_detect_required_objects` calls `get_model()` (lazy-loaded `YOLO(YOLO_MODEL)` with the PyTorch-2.6 `add_safe_globals` guard copied verbatim from the old `yolo.py`), runs inference per photo, collects detected class names case-insensitively from `result.names`, and maps them onto `REQUIRED_OBJECTS` with `required_objects_pass = all(present)`. The `except` branch marks every object `present=False` and emits `note="objects:yolo-unavailable (<err>), fallback"` only on load/inference failure. The happy-path note is `objects:yolo`. The curl transcript (step 11) and the seeded photo row both record `note="photo-quality:real; objects:yolo"`, confirming the model executed rather than the fallback. The weights file `backend/yolov8n.pt` is retained and the standalone YOLO router is deleted (`routers/yolo.py` no longer exists), satisfying AUTHZ-5 (no client-callable detection endpoint).

Photo quality is real Pillow (resolution + brightness + Laplacian-like sharpness → 0..1, pass ≥ 0.5, unreadable → score 0.0 with a note); document typing is a documented heuristic (filename/content-type keywords, confidence 1.0 on agreement else 0.5); OCR is an explicit stub (`ocr_text`/`extracted_fields` null, `ocr:stub` note). Each boundary is documented in the module docstring and in each row's `note` provenance string (FR-7.4).

### Roles, authorization, and the state machine (CL-2, AUTHZ-1..5)

`auth.py` adds `require_field_officer` and `require_front_office` next to `require_admin`, each admitting `admin` as a superset. The `/cases` router enforces ownership through `_require_owner` (field officers 403 on cases they do not own) and forces `officer_id == current.id` in both `list_cases` and `get_stats` so an officer can only ever see their own cases (AUTHZ-2). Front-office review endpoints use `require_front_office`, and officers hitting approve/reject get 403 — matched by curl step 10 (officer approve → 403).

The transition gate is correct: create → `Draft`; submit from `Draft`/`Needs Correction` → `Submitted` (else 409); approve/reject/request-correction only from `Submitted` (else 409), with `Completed`/`Rejected` terminal. Approve writes `status="Completed"` + `review_decision="Approved"` in one operation, so `Approved` is never persisted as a status. Submit enforces minimum content (customer_name + site_address non-empty and ≥1 photo, else 422 `"At least one photo is required before submitting"`), sets `captured_at` server-side, deletes prior `AIValidationResult` rows before re-running, and still transitions to `Submitted` even if validation raises (an aggregate `ai-error` row is persisted — FR-7.5). Reject and request-correction require a non-empty stripped comment (422); approve allows an empty comment. The curl transcript walks the full lifecycle including the 409 on resubmitting a `Completed` case (step 18) and the 422 for GPS latitude 100 (step 8) — the schema's `ge=-90/le=90` plus the `model_validator` coordinate-consistency check.

### Data model, schemas, shims, and wiring (design 1–10)

`database.py` defines the four new ORM classes with the exact columns, defaults, `JSON`-typed `required_objects`/`extracted_fields`, cascade relationships, and the canonical constant tuples; `Order`/`Detection` are gone. `schemas.py` carries the full case schema set with `from_attributes` on every response model and importing `GPS_STATUSES`/`DOCUMENT_TYPES` from `database` for a single source of truth. The three `models/*` shims re-export the new ORM and schema symbols with matching `__all__` lists — and `backend/.venv/bin/python -c "import models"` exits 0, which is the lockstep enforcement mechanism. `uploads.py` adds `/uploads/document` with a widened PDF allow-set via a parameterized `_store`, leaving the strict image endpoints unchanged. `main.py` registers `auth`/`uploads`/`verification` (orders/yolo dropped), keeps the `/uploads` static mount after the API routes, CORS for :4200/:4201, and the startup `create_tables()`. `seed.py` resets the DB, keeps the direct-bcrypt fallback, seeds admin + two officers + one front-office user, and six cases spanning every status with AI results produced by calling the real `validate_case`.

### Frontend route/screen/service map and null-guarding

`app.routes.ts` guards the `officer/*` subtree with `roleGuard(['field_officer','admin'])` and the `office/*` subtree with `roleGuard(['front_office','admin'])`, with `''` and `**` → `/login`. `AuthService` stores `user_role`, computes `homeRoute()`, and clears role on logout; the mock fallback defaults to `field_officer`. `CaseService` maps every snake_case field with `?? ''`/`?? null`/`Array.isArray(...)` guards and routes all calls through `environment.apiUrl` with a Bearer `authHeaders()` helper. The shared `AiResultsViewComponent` tolerates a null/non-array `results`, renders per-photo vs per-document rows by null-checking `photoId`/`documentId`, and shows "OCR not available" when `ocrText` is null. All officer/office/shared components (`officer-case-list`, `officer-case-form`, `case-details-form`, `photo-upload`, `document-upload`, `gps-capture`, `review-queue`, `case-review`, `completed-cases`, `overview`, `ai-results-view`, `photo-gallery`) and `config/case-columns.ts` with the canonical status set-filter are present; the old `dashboard`/`labeling`/`order.service`/`detection.service`/`order-columns` are removed. No `Order`/`Detection` symbols remain in `src/**/*.ts`.

### Verification evidence

`verification.md` records import health (`import main`, `import models`, `import main, models` all exit 0), the DB reset + seed output (4 users, 6 cases, 7 activity rows), two self-asserting test scripts passing, a 20-step live curl transcript with concrete status codes covering create/submit/attach/gps/review/resubmit/approve/terminal and the stats shape, the stored AI result rows showing real `objects:yolo` provenance, the REAL/HEURISTIC/STUB breakdown, and a clean `ng build --configuration development` with zero TS/template errors. Per the review mandate the suites were not re-run; the only spot-check performed (`import models` → `MODELS OK`) confirmed the shim lockstep.

</details>

<details>
<summary>File map</summary>

Backend (edited/created in place under `backend/`):
- `database.py` — new verification ORM + constants; `Order`/`Detection` removed.
- `schemas.py` — case request/response schemas; Order/Detection/Yolo schemas removed.
- `services/ai_validation.py` (new) — Pillow photo quality + REAL YOLO objects + heuristic doc type + stub OCR.
- `routers/verification.py` (new) — `/cases` router with full state machine + authz.
- `routers/auth.py` — adds `require_field_officer`/`require_front_office`.
- `routers/uploads.py` — adds `/uploads/document` (image + PDF).
- `routers/orders.py`, `routers/yolo.py` — deleted.
- `models/orm.py`, `models/schemas.py`, `models/__init__.py` — shims updated in lockstep.
- `main.py` — router rewiring + cosmetic strings.
- `seed.py` — verification-domain seed + DB-reset header.

Frontend (edited/created in place under `src/app/`):
- `services/case.service.ts`, `services/upload.service.ts` (new); `order.service.ts`/`detection.service.ts`/`labeling.service.ts` deleted.
- `auth/auth.service.ts`, `auth/auth.guard.ts` — role storage + `roleGuard`.
- `app.routes.ts` — officer/office subtrees with role guards.
- `config/case-columns.ts` (new); `config/order-columns.ts` deleted.
- `officer/*` and `office/*` component trees (new); `shared/ai-results-view`, `shared/photo-gallery` (new).
- `dashboard`/`labeling` components deleted.

Full diff: `git diff` in `/Users/irfan/Downloads/DashBoard-GenAI-master` (working tree, uncommitted).

</details>
