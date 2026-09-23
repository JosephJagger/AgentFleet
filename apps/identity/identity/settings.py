import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
SERVICE_TOKEN = os.environ["DJANGO_AUTH_SERVICE_TOKEN"]
if len(SECRET_KEY) < 32 or len(SERVICE_TOKEN) < 32:
    raise ValueError("Django secrets must contain at least 32 characters")
DEBUG = False
ALLOWED_HOSTS = os.getenv("DJANGO_ALLOWED_HOSTS", "identity,localhost,127.0.0.1,testserver").split(",")
INSTALLED_APPS = ["django.contrib.auth", "django.contrib.contenttypes", "accounts"]
MIDDLEWARE = ["django.middleware.security.SecurityMiddleware", "django.middleware.common.CommonMiddleware"]
ROOT_URLCONF = "identity.urls"
WSGI_APPLICATION = "identity.wsgi.application"
AUTH_USER_MODEL = "accounts.User"
DATABASES = {"default": {
    "ENGINE": "django.db.backends.sqlite3",
    "NAME": os.getenv("DJANGO_DATABASE_PATH", str(BASE_DIR / "identity.sqlite")),
    # Serialize rate accounting and OTP consumption across gunicorn workers.
    "OPTIONS": {"timeout": 20, "transaction_mode": "IMMEDIATE"},
}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "")
RESEND_FROM_NAME = os.getenv("RESEND_FROM_NAME", "AgentFleets")
OTP_TTL_SECONDS = 600
OTP_RESEND_SECONDS = 60
OTP_MAX_ATTEMPTS = 5
DATA_UPLOAD_MAX_MEMORY_SIZE = 8192
SECURE_CONTENT_TYPE_NOSNIFF = True
