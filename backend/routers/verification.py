"""
Verification cases router — the field site verification workflow.

Field Officer:
    POST   /cases                       create a Draft case
    GET    /cases                        list cases (officers see only their own)
    GET    /cases/stats                  KPI counts per status
    GET    /cases/activity               recent activity feed
    GET    /cases/{ref}                  case detail (owner / front office / admin)
    PUT    /cases/{ref}                  edit details (Draft / Needs Correction)
    POST   /cases/{ref}/photos           attach a photo
    DELETE /cases/{ref}/photos/{id}      remove a photo
    POST   /cases/{ref}/documents        attach a document
    DELETE /cases/{ref}/documents/{id}   remove a document
    PUT    /cases/{ref}/gps              set GPS/location
    POST   /cases/{ref}/submit           submit → runs AI validation

Front Office:
    POST   /cases/{ref}/approve             → Completed  (review_decision=Approved)
    POST   /cases/{ref}/reject              → Rejected   (comment required)
    POST   /cases/{ref}/request-correction  → Needs Correction (comment required)

Admin:
    DELETE /cases/{ref}                  delete a case
"""
import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import (
    ActivityLog, AIValidationResult, CaseDocument, CasePhoto,
    User, VerificationCase, get_db,
)
from routers.auth import (
    get_current_user, require_admin, require_field_officer, require_front_office,
)
from schemas import (
    CaseCreate, CaseDetailOut, CaseOut, CaseStats, CaseUpdate,
    DocumentAttach, GpsUpdate, PhotoAttach, PhotoOut, DocumentOut, ReviewAction,
    ActivityOut,
)
from services.ai_validation import AssetRef, validate_case

load_dotenv()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))

router = APIRouter(prefix="/cases", tags=["Verification Cases"])

# Statuses in which a case may still be edited by its owner.
_EDITABLE_STATUSES = ("Draft", "Needs Correction")


def _log(db: Session, user_name: str, action: str, order_ref: str = "", severity: str = "info"):
    db.add(ActivityLog(user_name=user_name, action=action,
                       order_ref=order_ref, severity=severity))
    db.commit()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_case_or_404(db: Session, case_ref: str) -> VerificationCase:
    case = db.query(VerificationCase).filter(VerificationCase.case_ref == case_ref).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


def _require_owner(case: VerificationCase, current: User):
    """Field officers may only act on their own cases (AUTHZ-2). Admin bypasses."""
    if current.role == "field_officer" and case.officer_id != current.id:
        raise HTTPException(status_code=403, detail="You do not own this case")


def _require_editable(case: VerificationCase):
    if case.status not in _EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Case cannot be edited in status '{case.status}'",
        )


def _next_case_ref(db: Session) -> str:
    """Generate the next VCNNN ref from the max existing numeric suffix."""
    max_num = 0
    for (ref,) in db.query(VerificationCase.case_ref).all():
        if ref and ref.upper().startswith("VC"):
            try:
                max_num = max(max_num, int(ref[2:]))
            except ValueError:
                continue
    return f"VC{max_num + 1:03d}"


def _to_case_out(case: VerificationCase) -> CaseOut:
    out = CaseOut.model_validate(case)
    out.assigned_officer = case.officer.name if case.officer else None
    return out


def _to_case_detail(case: VerificationCase) -> CaseDetailOut:
    out = CaseDetailOut.model_validate(case)
    out.assigned_officer = case.officer.name if case.officer else None
    return out


# ── List / search ──────────────────────────────────────────────────────────

@router.get("", response_model=List[CaseOut])
def list_cases(
    status: Optional[str] = Query(None, description="Filter by case status"),
    q:      Optional[str] = Query(None, description="Search case_ref / customer / site"),
    mine:   bool = Query(False, description="Front office/admin self-filter to own cases"),
    skip:   int = Query(0, ge=0),
    limit:  int = Query(100, le=500),
    db:      Session = Depends(get_db),
    current: User    = Depends(get_current_user),
):
    query = db.query(VerificationCase)

    # Field officers are ALWAYS restricted to their own cases (AUTHZ-2).
    if current.role == "field_officer":
        query = query.filter(VerificationCase.officer_id == current.id)
    elif mine:
        query = query.filter(VerificationCase.officer_id == current.id)

    if status:
        query = query.filter(VerificationCase.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            VerificationCase.case_ref.ilike(like)
            | VerificationCase.customer_name.ilike(like)
            | VerificationCase.site_id.ilike(like)
        )

    cases = query.order_by(VerificationCase.created_at.desc()).offset(skip).limit(limit).all()
    return [_to_case_out(c) for c in cases]


# ── KPI stats ────────────────────────────────────────────────────────────────

@router.get("/stats", response_model=CaseStats)
def get_stats(
    db:      Session = Depends(get_db),
    current: User    = Depends(get_current_user),
):
    query = db.query(VerificationCase)
    if current.role == "field_officer":
        query = query.filter(VerificationCase.officer_id == current.id)

    def count(s: str) -> int:
        return query.filter(VerificationCase.status == s).count()

    return CaseStats(
        total            = query.count(),
        draft            = count("Draft"),
        submitted        = count("Submitted"),
        needs_correction = count("Needs Correction"),
        rejected         = count("Rejected"),
        completed        = count("Completed"),
    )


# ── Activity feed ──────────────────────────────────────────────────────────

@router.get("/activity", response_model=List[ActivityOut], tags=["Activity"])
def get_activity(
    limit: int = Query(20, le=100),
    db:    Session = Depends(get_db),
    _:     User    = Depends(get_current_user),
):
    return (
        db.query(ActivityLog)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
        .all()
    )


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", response_model=CaseDetailOut, status_code=201)
def create_case(
    body:    CaseCreate,
    db:      Session = Depends(get_db),
    current: User    = Depends(require_field_officer),
):
    case_ref = (body.case_ref or "").strip() or _next_case_ref(db)
    if db.query(VerificationCase).filter(VerificationCase.case_ref == case_ref).first():
        raise HTTPException(status_code=409, detail="case_ref already exists")

    case = VerificationCase(
        case_ref          = case_ref,
        status            = "Draft",
        customer_name     = body.customer_name,
        site_address      = body.site_address,
        site_id           = body.site_id,
        contact           = body.contact,
        verification_type = body.verification_type,
        notes             = body.notes or "",
        officer_id        = current.id,
    )
    db.add(case)
    db.commit()
    db.refresh(case)

    _log(db, current.name, f"Created case {case.case_ref}", case.case_ref, "success")
    return _to_case_detail(case)


# ── Get one ───────────────────────────────────────────────────────────────────

@router.get("/{case_ref}", response_model=CaseDetailOut)
def get_case(
    case_ref: str,
    db:       Session = Depends(get_db),
    current:  User    = Depends(get_current_user),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    return _to_case_detail(case)


# ── Update details ─────────────────────────────────────────────────────────

@router.put("/{case_ref}", response_model=CaseDetailOut)
def update_case(
    case_ref: str,
    body:     CaseUpdate,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    updates = body.model_dump(exclude_none=True)
    for key, val in updates.items():
        setattr(case, key, val)
    db.commit()
    db.refresh(case)

    _log(db, current.name, f"Updated case {case.case_ref}", case.case_ref, "info")
    return _to_case_detail(case)


# ── Photos ────────────────────────────────────────────────────────────────────

@router.post("/{case_ref}/photos", response_model=PhotoOut, status_code=201)
def attach_photo(
    case_ref: str,
    body:     PhotoAttach,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    photo = CasePhoto(
        case_id       = case.id,
        url           = body.url,
        original_name = body.original_name or "",
        caption       = body.caption or "",
        category      = body.category or "",
    )
    db.add(photo)
    db.commit()
    db.refresh(photo)

    _log(db, current.name, f"Attached photo to {case.case_ref}", case.case_ref, "info")
    return photo


@router.delete("/{case_ref}/photos/{photo_id}", status_code=204)
def delete_photo(
    case_ref: str,
    photo_id: int,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    photo = (
        db.query(CasePhoto)
        .filter(CasePhoto.id == photo_id, CasePhoto.case_id == case.id)
        .first()
    )
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    db.delete(photo)
    db.commit()
    _log(db, current.name, f"Removed photo from {case.case_ref}", case.case_ref, "warning")


# ── Documents ──────────────────────────────────────────────────────────────

@router.post("/{case_ref}/documents", response_model=DocumentOut, status_code=201)
def attach_document(
    case_ref: str,
    body:     DocumentAttach,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    doc = CaseDocument(
        case_id       = case.id,
        url           = body.url,
        original_name = body.original_name or "",
        document_type = body.document_type,
        content_type  = body.content_type or "",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    _log(db, current.name, f"Attached document to {case.case_ref}", case.case_ref, "info")
    return doc


@router.delete("/{case_ref}/documents/{doc_id}", status_code=204)
def delete_document(
    case_ref: str,
    doc_id:   int,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    doc = (
        db.query(CaseDocument)
        .filter(CaseDocument.id == doc_id, CaseDocument.case_id == case.id)
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    db.delete(doc)
    db.commit()
    _log(db, current.name, f"Removed document from {case.case_ref}", case.case_ref, "warning")


# ── GPS ────────────────────────────────────────────────────────────────────

@router.put("/{case_ref}/gps", response_model=CaseDetailOut)
def set_gps(
    case_ref: str,
    body:     GpsUpdate,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)
    _require_editable(case)

    case.latitude   = body.latitude
    case.longitude  = body.longitude
    case.gps_status = body.gps_status
    db.commit()
    db.refresh(case)

    _log(db, current.name, f"Set GPS ({case.gps_status}) on {case.case_ref}", case.case_ref, "info")
    return _to_case_detail(case)


# ── Submit (runs AI validation) ──────────────────────────────────────────────

def _resolve_path(url: str) -> str:
    """Resolve a stored /uploads/<name> URL to an absolute filesystem path."""
    return str((UPLOAD_DIR / Path(url).name).resolve())


@router.post("/{case_ref}/analyze", response_model=CaseDetailOut)
def analyze_case(
    case_ref: str,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    """Run AI validation on the case's photos/documents WITHOUT submitting.

    Lets an officer analyze the provided images and review the AI results before
    deciding to submit. The case status is left unchanged; prior AI results are
    refreshed so repeated analysis is idempotent.
    """
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)

    if case.status not in _EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot analyze a case in status '{case.status}'",
        )
    if not case.photos:
        raise HTTPException(status_code=422, detail="Attach at least one photo before analyzing")

    photo_refs = [
        AssetRef("photo", p.id, _resolve_path(p.url), p.original_name or "", "")
        for p in case.photos
    ]
    doc_refs = [
        AssetRef("document", d.id, _resolve_path(d.url),
                 d.original_name or "", d.content_type or "", d.document_type or "Other")
        for d in case.documents
    ]

    # Refresh: delete prior AI results before re-running.
    db.query(AIValidationResult).filter(AIValidationResult.case_id == case.id).delete()
    db.commit()

    try:
        results = validate_case(photo_refs, doc_refs)
        for r in results:
            db.add(AIValidationResult(case_id=case.id, **r))
        note = f"analyzed images ({len(results)} AI result(s))"
        severity = "info"
    except Exception as exc:
        db.add(AIValidationResult(
            case_id=case.id,
            photo_quality_pass=False,
            required_objects_pass=False,
            note=f"ai-error: {exc}",
        ))
        note = f"AI analysis error: {exc}"
        severity = "warning"

    db.commit()
    db.refresh(case)

    _log(db, current.name, f"Analyzed case {case.case_ref}; {note}", case.case_ref, severity)
    return _to_case_detail(case)


@router.post("/{case_ref}/submit", response_model=CaseDetailOut)
def submit_case(
    case_ref: str,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_field_officer),
):
    case = _get_case_or_404(db, case_ref)
    _require_owner(case, current)

    if case.status not in _EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot submit a case in status '{case.status}'",
        )

    # Minimum-content validation (FR-6.3).
    if not (case.customer_name or "").strip() or not (case.site_address or "").strip():
        raise HTTPException(status_code=422, detail="Customer name and site address are required")
    if not case.photos:
        raise HTTPException(status_code=422, detail="At least one photo is required before submitting")

    # Server-side timestamp (FR-5.4) — ignore any client value.
    case.captured_at = datetime.utcnow()

    # Build AssetRefs and run AI validation inside a try/except (FR-7.5).
    photo_refs = [
        AssetRef("photo", p.id, _resolve_path(p.url), p.original_name or "", "")
        for p in case.photos
    ]
    doc_refs = [
        AssetRef("document", d.id, _resolve_path(d.url),
                 d.original_name or "", d.content_type or "", d.document_type or "Other")
        for d in case.documents
    ]

    # Refresh: delete prior AI results for this case before re-running.
    db.query(AIValidationResult).filter(AIValidationResult.case_id == case.id).delete()
    db.commit()

    try:
        results = validate_case(photo_refs, doc_refs)
        for r in results:
            db.add(AIValidationResult(case_id=case.id, **r))
        ai_severity = "info"
        ai_note = f"ran AI validation ({len(results)} result(s))"
    except Exception as exc:
        # Catastrophic failure — record one aggregate error row; still submit.
        db.add(AIValidationResult(
            case_id=case.id,
            photo_quality_pass=False,
            required_objects_pass=False,
            note=f"ai-error: {exc}",
        ))
        ai_severity = "error"
        ai_note = f"AI validation error: {exc}"

    case.status = "Submitted"
    db.commit()
    db.refresh(case)

    _log(db, current.name, f"Submitted case {case.case_ref}; {ai_note}", case.case_ref,
         "warning" if ai_severity == "error" else "success")
    return _to_case_detail(case)


# ── Review (front office) ─────────────────────────────────────────────────────

def _review(
    db: Session, case: VerificationCase, current: User,
    decision: str, new_status: str, comment: Optional[str], require_comment: bool,
    severity: str,
) -> VerificationCase:
    if case.status != "Submitted":
        raise HTTPException(
            status_code=409,
            detail=f"Only a Submitted case can be reviewed (current: '{case.status}')",
        )
    cleaned = (comment or "").strip()
    if require_comment and not cleaned:
        raise HTTPException(status_code=422, detail="A review comment is required")

    case.review_decision = decision
    case.reviewer        = current.name
    case.review_comment  = cleaned or None
    case.reviewed_at     = datetime.utcnow()
    case.status          = new_status
    db.commit()
    db.refresh(case)

    _log(db, current.name, f"{decision} case {case.case_ref}", case.case_ref, severity)
    return case


@router.post("/{case_ref}/approve", response_model=CaseDetailOut)
def approve_case(
    case_ref: str,
    body:     ReviewAction,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_front_office),
):
    case = _get_case_or_404(db, case_ref)
    case = _review(db, case, current, "Approved", "Completed", body.comment, False, "success")
    return _to_case_detail(case)


@router.post("/{case_ref}/reject", response_model=CaseDetailOut)
def reject_case(
    case_ref: str,
    body:     ReviewAction,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_front_office),
):
    case = _get_case_or_404(db, case_ref)
    case = _review(db, case, current, "Rejected", "Rejected", body.comment, True, "error")
    return _to_case_detail(case)


@router.post("/{case_ref}/request-correction", response_model=CaseDetailOut)
def request_correction(
    case_ref: str,
    body:     ReviewAction,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_front_office),
):
    case = _get_case_or_404(db, case_ref)
    case = _review(db, case, current, "Needs Correction", "Needs Correction",
                   body.comment, True, "warning")
    return _to_case_detail(case)


# ── Delete (admin) ─────────────────────────────────────────────────────────

@router.delete("/{case_ref}", status_code=204)
def delete_case(
    case_ref: str,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_admin),
):
    case = _get_case_or_404(db, case_ref)
    db.delete(case)
    db.commit()
    _log(db, current.name, f"Deleted case {case_ref}", case_ref, "warning")
