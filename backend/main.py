"""
FastAPI entry point.
Run:  uvicorn main:app --reload --port 8000
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import create_tables
from routers import auth, uploads, verification

load_dotenv()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title       = "Field Site Verification API",
    description = "FastAPI backend for the Field Site Verification workflow",
    version     = "2.0.0",
    docs_url    = "/docs",
    redoc_url   = "/redoc",
)

# ── CORS (allow Angular dev server) ─────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins     = ["http://localhost:4200", "http://localhost:4201"],
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)

# ── Routers ──────────────────────────────────────────────────────────────────
# Registered BEFORE the static mount so the uploads API routes (POST /uploads,
# /uploads/single, /uploads/document) resolve ahead of the catch-all StaticFiles
# mount at /uploads (which otherwise shadows any /uploads/* request for every
# method). GET requests for actual stored files have no API route and so fall
# through to the static mount below.
app.include_router(auth.router)
app.include_router(uploads.router)
app.include_router(verification.router)

# ── Static files (uploaded images, served at /uploads/<name>) ────────────────
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


# ── Startup ───────────────────────────────────────────────────────────────────
@app.on_event("startup")
def startup():
    create_tables()
    print("✅  Database tables ready")


@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "message": "Field Site Verification API is running"}


@app.get("/health", tags=["Health"])
def health():
    return {"status": "healthy"}
