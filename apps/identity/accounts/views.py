import json
import math
import re
import secrets
import uuid
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import connection, transaction
from django.http import JsonResponse
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac

from .email import DeliveryError, send_code
from .models import EmailChallenge, RateEvent, User


def error(status, code, message, retry_after=None):
    response = JsonResponse({"error": {"code": code, "message": message},
                             **({"retryAfter": retry_after} if retry_after else {})}, status=status)
    if retry_after:
        response["Retry-After"] = str(retry_after)
    return response


def internal(view):
    @wraps(view)
    def wrapped(request):
        if request.method != "POST":
            return error(405, "METHOD_NOT_ALLOWED", "POST required")
        if not constant_time_compare(request.headers.get("Authorization", ""), f"Bearer {settings.SERVICE_TOKEN}"):
            return error(401, "AUTH_REQUIRED", "Service authentication required")
        try:
            body = json.loads(request.body)
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, UnicodeDecodeError):
            return error(400, "INVALID_INPUT", "Invalid request")
        response = view(body)
        response["Cache-Control"] = "no-store"
        return response
    return wrapped


def digest(namespace, value):
    return salted_hmac(namespace, value, algorithm="sha256").hexdigest()


def code_digest(challenge_id, email, code):
    return digest("agentfleets-otp", f"{challenge_id}:{email}:{code}")


def rate_limit(rules):
    """Called inside an IMMEDIATE transaction; all workers share durable limits."""
    now = timezone.now()
    RateEvent.objects.filter(created_at__lt=now - timedelta(days=1)).delete()
    retry = 0
    for scope, value, limit, seconds in rules:
        events = RateEvent.objects.filter(scope=scope, key_digest=digest(scope, value),
                                          created_at__gt=now - timedelta(seconds=seconds))
        if events.count() >= limit:
            oldest = events.order_by("created_at").first()
            retry = max(retry, math.ceil((oldest.created_at + timedelta(seconds=seconds) - now).total_seconds()))
    if retry:
        return error(429, "RATE_LIMITED", "Too many attempts. Please try again later.", max(1, retry))
    RateEvent.objects.bulk_create([RateEvent(scope=s, key_digest=digest(s, v)) for s, v, _, _ in rules])
    return None


@internal
def request_code(body):
    email = body.get("email")
    ip = body.get("clientIp")
    if not isinstance(email, str) or not isinstance(ip, str) or not 1 <= len(ip) <= 100:
        return error(400, "INVALID_INPUT", "Invalid email address")
    email = email.strip().lower()
    try:
        validate_email(email)
        if len(email) > 254:
            raise ValidationError("email")
    except ValidationError:
        return error(400, "INVALID_INPUT", "Invalid email address")
    if not settings.RESEND_API_KEY or not settings.RESEND_FROM_EMAIL:
        return error(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email delivery is temporarily unavailable")
    now = timezone.now()
    with transaction.atomic():
        limited = rate_limit([
            ("send-cooldown", email, 1, settings.OTP_RESEND_SECONDS),
            ("send-email", email, 5, 3600), ("send-ip", ip, 20, 3600),
            ("send-global-hour", "all", 200, 3600), ("send-global-day", "all", 1000, 86400),
        ])
        if limited is not None:
            return limited
        EmailChallenge.objects.filter(created_at__lt=now - timedelta(days=1)).delete()
        challenge_id = uuid.uuid4()
        code = f"{secrets.randbelow(1_000_000):06d}"
        challenge = EmailChallenge.objects.create(
            id=challenge_id, email=email, code_digest=code_digest(challenge_id, email, code),
            expires_at=now + timedelta(seconds=settings.OTP_TTL_SECONDS))
    try:
        send_code(email, code, challenge.id, body.get("locale", "en"))
    except DeliveryError:
        EmailChallenge.objects.filter(pk=challenge.id).update(consumed=True)
        return error(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email delivery is temporarily unavailable")
    with transaction.atomic():
        # A newer send invalidates every older code for this email.
        EmailChallenge.objects.filter(email=email, created_at__lt=challenge.created_at).update(consumed=True)
        EmailChallenge.objects.filter(pk=challenge.id).update(sent=True)
    return JsonResponse({"challengeId": str(challenge.id), "expiresIn": settings.OTP_TTL_SECONDS,
                         "resendAfter": settings.OTP_RESEND_SECONDS})


@internal
def verify_code(body):
    try:
        challenge_id = uuid.UUID(body.get("challengeId", ""))
    except (ValueError, TypeError, AttributeError):
        return error(400, "INVALID_INPUT", "Invalid verification request")
    code, ip = body.get("code"), body.get("clientIp")
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code) or not isinstance(ip, str) or not 1 <= len(ip) <= 100:
        return error(400, "INVALID_INPUT", "Enter a six-digit code")
    invalid = error(401, "INVALID_OR_EXPIRED_CODE", "The code is invalid or expired")
    with transaction.atomic():
        limited = rate_limit([("verify-ip", ip, 60, 3600)])
        if limited is not None:
            return limited
        challenge = EmailChallenge.objects.filter(pk=challenge_id).first()
        if (not challenge or not challenge.sent or challenge.consumed
                or challenge.expires_at <= timezone.now() or challenge.attempts >= settings.OTP_MAX_ATTEMPTS):
            return invalid
        challenge.attempts += 1
        if not constant_time_compare(challenge.code_digest, code_digest(challenge.id, challenge.email, code)):
            challenge.save(update_fields=["attempts"])
            return invalid
        challenge.consumed = True
        challenge.save(update_fields=["attempts", "consumed"])
        user = User.objects.filter(email=challenge.email).first()
        if user is None:
            user = User(email=challenge.email, username=str(uuid.uuid4()))
            user.set_unusable_password()
            user.save()
        if not user.is_active:
            return invalid
        user.last_login = timezone.now()
        user.save(update_fields=["last_login"])
        return JsonResponse({"user": {"id": str(user.id), "email": user.email}})


def health(request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return JsonResponse({"status": "ok"})
