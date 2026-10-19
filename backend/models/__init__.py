"""
models package — a single, convenient namespace for the application's data layer.

The project historically kept the SQLAlchemy ORM models in `database.py` and the
Pydantic request/response schemas in `schemas.py`, imported flatly throughout the
routers. This package does NOT move those definitions (that would break every
existing `from database import ...` / `from schemas import ...` import); instead it
re-exports them so new code can use one clear location:

    from models import User, VerificationCase, CasePhoto      # ORM (SQLAlchemy)
    from models import CaseOut, CaseDetailOut, UploadResult   # Pydantic

Submodules:
    models.orm      → SQLAlchemy ORM models + Base/engine/session helpers
    models.schemas  → Pydantic v2 schemas
"""
from . import orm, schemas

# ── SQLAlchemy ORM models + helpers ──────────────────────────────────────────
from .orm import (
    Base,
    engine,
    SessionLocal,
    User,
    VerificationCase,
    CasePhoto,
    CaseDocument,
    AIValidationResult,
    ActivityLog,
    get_db,
    create_tables,
    CASE_STATUSES,
    REVIEW_DECISIONS,
    DOCUMENT_TYPES,
    GPS_STATUSES,
)

# ── Pydantic schemas ─────────────────────────────────────────────────────────
from .schemas import (
    # auth
    RegisterRequest,
    LoginRequest,
    TokenResponse,
    UserOut,
    # verification case (requests)
    CaseCreate,
    CaseUpdate,
    GpsUpdate,
    PhotoAttach,
    DocumentAttach,
    ReviewAction,
    # verification case (responses)
    PhotoOut,
    DocumentOut,
    AIResultOut,
    CaseOut,
    CaseDetailOut,
    CaseStats,
    # activity
    ActivityOut,
    # uploads
    UploadResult,
)

__all__ = [
    # subpackages
    "orm",
    "schemas",
    # ORM + helpers
    "Base",
    "engine",
    "SessionLocal",
    "User",
    "VerificationCase",
    "CasePhoto",
    "CaseDocument",
    "AIValidationResult",
    "ActivityLog",
    "get_db",
    "create_tables",
    "CASE_STATUSES",
    "REVIEW_DECISIONS",
    "DOCUMENT_TYPES",
    "GPS_STATUSES",
    # schemas
    "RegisterRequest",
    "LoginRequest",
    "TokenResponse",
    "UserOut",
    "CaseCreate",
    "CaseUpdate",
    "GpsUpdate",
    "PhotoAttach",
    "DocumentAttach",
    "ReviewAction",
    "PhotoOut",
    "DocumentOut",
    "AIResultOut",
    "CaseOut",
    "CaseDetailOut",
    "CaseStats",
    "ActivityOut",
    "UploadResult",
]
