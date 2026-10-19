"""
Authentication router — /auth/register, /auth/login, /auth/me
JWT-based, passwords hashed with bcrypt.
"""
import os
from datetime import datetime, timedelta
from typing import Annotated

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import ActivityLog, User, get_db
from schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut

load_dotenv()

SECRET_KEY  = os.getenv("SECRET_KEY", "changeme")
ALGORITHM   = os.getenv("ALGORITHM", "HS256")
EXPIRE_MIN  = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 60))

pwd_ctx   = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2    = OAuth2PasswordBearer(tokenUrl="/auth/login")
router    = APIRouter(prefix="/auth", tags=["Auth"])


# ── Helpers ────────────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def create_token(data: dict) -> str:
    payload = data.copy()
    # The JWT "sub" claim MUST be a string; python-jose rejects non-string
    # subjects at decode time. Store the user id as a string here and cast it
    # back to int in get_current_user.
    if "sub" in payload and payload["sub"] is not None:
        payload["sub"] = str(payload["sub"])
    payload["exp"] = datetime.utcnow() + timedelta(minutes=EXPIRE_MIN)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_current_user(
    token: Annotated[str, Depends(oauth2)],
    db:    Session = Depends(get_db),
) -> User:
    payload = decode_token(token)
    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    try:
        user_id = int(sub)   # "sub" is stored as a string per the JWT spec
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token subject")
    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def require_admin(current: User = Depends(get_current_user)) -> User:
    if current.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current


def require_field_officer(current: User = Depends(get_current_user)) -> User:
    # admin is treated as a superset of both operational roles for operability.
    if current.role not in ("field_officer", "admin"):
        raise HTTPException(status_code=403, detail="Field officer access required")
    return current


def require_front_office(current: User = Depends(get_current_user)) -> User:
    if current.role not in ("front_office", "admin"):
        raise HTTPException(status_code=403, detail="Front office access required")
    return current


def _log(db: Session, user_name: str, action: str, order_ref: str = "", severity: str = "info"):
    db.add(ActivityLog(user_name=user_name, action=action,
                       order_ref=order_ref, severity=severity))
    db.commit()


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse, status_code=201)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(
        name      = body.name,
        email     = body.email,
        hashed_pw = hash_password(body.password),
        role      = body.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    _log(db, user.name, f"Registered new account ({user.role})", severity="info")

    token = create_token({"sub": user.id, "role": user.role})
    return TokenResponse(
        access_token=token,
        user_name=user.name,
        user_role=user.role,
        user_id=user.id,
    )


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_pw):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    _log(db, user.name, "Logged in", severity="info")

    token = create_token({"sub": user.id, "role": user.role})
    return TokenResponse(
        access_token=token,
        user_name=user.name,
        user_role=user.role,
        user_id=user.id,
    )


# OAuth2 form login (for Swagger "Authorize" button)
@router.post("/token", response_model=TokenResponse, include_in_schema=False)
def token_form(
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    db:   Session = Depends(get_db),
):
    return login(LoginRequest(email=form.username, password=form.password), db)


@router.get("/me", response_model=UserOut)
def me(current: User = Depends(get_current_user)):
    return current


@router.get("/users", response_model=list[UserOut])
def list_users(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return db.query(User).all()
