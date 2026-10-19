"""
Uploads router — store image files on disk and expose them via /uploads/<name>.

POST   /uploads            upload one or more images → returns public URLs
POST   /uploads/single     upload exactly one image → returns a single URL
DELETE /uploads/{filename} remove a previously uploaded file (admin only)

Files are written to UPLOAD_DIR (served statically at /uploads by main.py).
These endpoints let the frontend push images to the server before attaching
them to an order or running YOLO detection.
"""
import os
import uuid
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from fastapi import (
    APIRouter, Depends, File, HTTPException, UploadFile, status,
)
from sqlalchemy.orm import Session

from database import ActivityLog, User, get_db
from routers.auth import get_current_user, require_admin
from schemas import UploadResult

load_dotenv()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Guardrails for untrusted uploads
ALLOWED_EXT  = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif", ".tiff"}
ALLOWED_MIME = {
    "image/jpeg", "image/png", "image/bmp",
    "image/webp", "image/gif", "image/tiff",
}
# Documents additionally allow PDF (images + PDF). The image endpoints stay
# strict; only the dedicated document endpoint widens the allow-set.
ALLOWED_DOC_EXT  = ALLOWED_EXT | {".pdf"}
ALLOWED_DOC_MIME = ALLOWED_MIME | {"application/pdf"}
MAX_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", 20 * 1024 * 1024))  # 20 MB default

router = APIRouter(prefix="/uploads", tags=["Uploads"])


def _log(db: Session, user_name: str, action: str, severity: str = "info"):
    db.add(ActivityLog(user_name=user_name, action=action, severity=severity))
    db.commit()


def _safe_ext(filename: str, allowed_ext=ALLOWED_EXT) -> str:
    """Return a validated, lower-cased extension or raise 415."""
    ext = Path(filename or "").suffix.lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type '{ext or 'unknown'}'. "
                   f"Allowed: {', '.join(sorted(allowed_ext))}",
        )
    return ext


async def _store(file: UploadFile, allowed_ext=ALLOWED_EXT, allowed_mime=ALLOWED_MIME) -> UploadResult:
    """Validate and persist a single UploadFile, returning its public URL.

    `allowed_ext`/`allowed_mime` default to the strict image sets so the existing
    image endpoints are unchanged; the document endpoint passes the widened sets.
    """
    # Validate declared content type when present (don't trust it fully — just a cheap guard)
    if file.content_type and file.content_type not in allowed_mime:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported content type '{file.content_type}'",
        )

    ext      = _safe_ext(file.filename, allowed_ext)
    contents = await file.read()

    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_BYTES // (1024 * 1024)} MB limit",
        )

    # Random server-side name avoids path traversal and collisions
    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest        = UPLOAD_DIR / stored_name
    with open(dest, "wb") as out:
        out.write(contents)

    return UploadResult(
        filename      = stored_name,
        original_name = file.filename or stored_name,
        url           = f"/uploads/{stored_name}",
        size          = len(contents),
        content_type  = file.content_type or "",
    )


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("", response_model=List[UploadResult], status_code=201)
async def upload_images(
    files:   List[UploadFile] = File(..., description="One or more image files"),
    db:      Session = Depends(get_db),
    current: User    = Depends(get_current_user),
):
    """Upload one or more images; returns a list of stored-file descriptors."""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    results = [await _store(f) for f in files]
    _log(db, current.name, f"Uploaded {len(results)} image(s)", "success")
    return results


@router.post("/single", response_model=UploadResult, status_code=201)
async def upload_single_image(
    file:    UploadFile = File(..., description="A single image file"),
    db:      Session = Depends(get_db),
    current: User    = Depends(get_current_user),
):
    """Upload exactly one image; returns one stored-file descriptor."""
    result = await _store(file)
    _log(db, current.name, f"Uploaded image {result.original_name}", "success")
    return result


@router.post("/document", response_model=UploadResult, status_code=201)
async def upload_document(
    file:    UploadFile = File(..., description="A single document (image or PDF)"),
    db:      Session = Depends(get_db),
    current: User    = Depends(get_current_user),
):
    """Upload exactly one document (image or PDF); returns one stored-file descriptor."""
    result = await _store(file, ALLOWED_DOC_EXT, ALLOWED_DOC_MIME)
    _log(db, current.name, f"Uploaded document {result.original_name}", "success")
    return result


@router.delete("/{filename}", status_code=204)
def delete_upload(
    filename: str,
    db:       Session = Depends(get_db),
    current:  User    = Depends(require_admin),
):
    """Delete a previously uploaded file (admin only)."""
    # Reject anything that isn't a bare filename to prevent path traversal
    safe = Path(filename).name
    if safe != filename or not safe:
        raise HTTPException(status_code=400, detail="Invalid filename")

    target = UPLOAD_DIR / safe
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        target.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not delete file: {exc}")

    _log(db, current.name, f"Deleted upload {safe}", "warning")
