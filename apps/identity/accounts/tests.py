import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase, override_settings
from django.utils import timezone

from .email import DeliveryError, send_code
from .models import EmailChallenge, RateEvent, User


@override_settings(RESEND_API_KEY="test-provider-key", RESEND_FROM_EMAIL="login@example.com")
class EmailLoginTests(TestCase):
    def setUp(self):
        self.sender = patch("accounts.views.send_code").start()
        self.addCleanup(patch.stopall)

    def post(self, action, body, authenticated=True):
        return self.client.post("/internal/auth/" + action, body, content_type="application/json",
                                HTTP_AUTHORIZATION=f"Bearer {settings.SERVICE_TOKEN}" if authenticated else "")

    def request_code(self, email="owner@example.com", ip="192.0.2.1"):
        response = self.post("request-code", {"email": email, "clientIp": ip, "locale": "zh"})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["challengeId"], self.sender.call_args.args[1]

    def verify(self, challenge, code):
        return self.post("verify-code", {"challengeId": challenge, "code": code, "clientIp": "192.0.2.1"})

    def test_signup_normalization_single_use_and_repeat_login(self):
        challenge, code = self.request_code(" Owner@Example.com ")
        self.assertEqual(User.objects.count(), 0)
        row = EmailChallenge.objects.get(pk=challenge)
        self.assertNotEqual(row.code_digest, code)
        response = self.verify(challenge, code)
        self.assertEqual(response.status_code, 200)
        user = User.objects.get()
        self.assertEqual(user.email, "owner@example.com")
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.is_superuser)
        self.assertEqual(self.verify(challenge, code).status_code, 401)
        RateEvent.objects.all().delete()
        second, second_code = self.request_code()
        self.assertEqual(self.verify(second, second_code).json()["user"]["id"], response.json()["user"]["id"])
        self.assertEqual(User.objects.count(), 1)

    def test_wrong_attempts_are_committed_and_lock_correct_code(self):
        challenge, code = self.request_code()
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.verify(challenge, wrong).status_code, 401)
        self.assertEqual(EmailChallenge.objects.get(pk=challenge).attempts, 5)
        self.assertEqual(self.verify(challenge, code).status_code, 401)
        self.assertEqual(User.objects.count(), 0)

    def test_expired_failed_delivery_and_disabled_user_cannot_login(self):
        challenge, code = self.request_code()
        EmailChallenge.objects.filter(pk=challenge).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.verify(challenge, code).status_code, 401)
        self.sender.side_effect = DeliveryError()
        response = self.post("request-code", {"email": "failed@example.com", "clientIp": "192.0.2.1"})
        self.assertEqual(response.status_code, 503)
        failed = EmailChallenge.objects.get(email="failed@example.com")
        self.assertFalse(failed.sent)
        self.assertTrue(failed.consumed)
        self.sender.side_effect = None
        User.objects.create_user(username="disabled", email="disabled@example.com", is_active=False)
        challenge, code = self.request_code("disabled@example.com")
        self.assertEqual(self.verify(challenge, code).status_code, 401)

    def test_cooldown_and_resend_invalidates_old_code(self):
        first, first_code = self.request_code()
        response = self.post("request-code", {"email": "OWNER@example.com", "clientIp": "192.0.2.2"})
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response["Retry-After"]), 0)
        self.assertEqual(self.sender.call_count, 1)
        RateEvent.objects.all().delete()
        second, second_code = self.request_code()
        self.assertEqual(self.verify(first, first_code).status_code, 401)
        self.assertEqual(self.verify(second, second_code).status_code, 200)

    def test_internal_auth_validation_and_email_binding(self):
        self.assertEqual(self.post("request-code", {}, authenticated=False).status_code, 401)
        for body in [{}, [], {"email": "invalid", "clientIp": "192.0.2.1"}]:
            self.assertEqual(self.post("request-code", body).status_code, 400)
        challenge, code = self.request_code()
        response = self.post("verify-code", {"challengeId": challenge, "code": code,
                                             "clientIp": "192.0.2.1", "email": "attacker@example.com"})
        self.assertEqual(response.json()["user"]["email"], "owner@example.com")
        self.assertEqual(self.verify(str(uuid.uuid4()), code).status_code, 401)
        self.assertEqual(self.verify("invalid", code).status_code, 400)

    def test_hourly_email_and_ip_limits_persist(self):
        for i in range(5):
            RateEvent.objects.filter(scope="send-cooldown").delete()
            self.request_code()
        RateEvent.objects.filter(scope="send-cooldown").delete()
        self.assertEqual(self.post("request-code", {"email": "owner@example.com", "clientIp": "other"}).status_code, 429)
        for i in range(15):
            self.request_code(f"user{i}@example.com")
        self.assertEqual(self.post("request-code", {"email": "extra@example.com", "clientIp": "192.0.2.1"}).status_code, 429)

    @override_settings(RESEND_FROM_EMAIL="")
    def test_missing_sender_fails_without_creating_a_challenge(self):
        self.assertEqual(self.post("request-code", {"email": "owner@example.com", "clientIp": "192.0.2.1"}).status_code, 503)
        self.assertEqual(EmailChallenge.objects.count(), 0)

    @patch("accounts.email.httpx.post")
    def test_resend_request_is_server_side_and_provider_response_is_not_exposed(self, post):
        post.return_value.json.return_value = {"id": "message-id"}
        send_code("recipient@example.com", "123456", "challenge", "zh")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://api.resend.com/emails")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-provider-key")
        self.assertEqual(kwargs["json"]["to"], ["recipient@example.com"])
        self.assertIn("123456", kwargs["json"]["text"])
        post.return_value.json.return_value = {"error": "private provider response"}
        with self.assertRaises(DeliveryError):
            send_code("recipient@example.com", "123456", "challenge", "en")
