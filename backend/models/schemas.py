"""
models.schemas — re-export of the Pydantic v2 schemas.

The schemas live in the top-level `schemas.py` module (kept there so existing
flat `from schemas import ...` imports keep working). This module re-exports them
under the `models.schemas` namespace so new code can import them from a single,
descriptive location:

    from models.schemas import CaseOut, CaseDetailOut, UploadResult

There is exactly one definition of each schema — this is a view onto it, not a copy.
"""
from schemas import (
    RegisterRequest,
    LoginRequest,
    TokenResponse,
    UserOut,
    CaseCreate,
    CaseUpdate,
    GpsUpdate,
    PhotoAttach,
    DocumentAttach,
    ReviewAction,
    PhotoOut,
    DocumentOut,
    AIResultOut,
    CaseOut,
    CaseDetailOut,
    CaseStats,
    ActivityOut,
    UploadResult,
)

__all__ = [
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
