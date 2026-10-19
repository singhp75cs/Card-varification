"""
models.orm — re-export of the SQLAlchemy ORM layer.

The ORM models and session helpers live in the top-level `database.py` module
(kept there so the existing flat `from database import ...` imports in the routers
keep working). This module simply re-exports them under the `models.orm`
namespace so new code can import them from a single, descriptive location:

    from models.orm import User, VerificationCase, CasePhoto, get_db

There is exactly one definition of each class — this is a view onto it, not a copy.
"""
from database import (
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

__all__ = [
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
]
