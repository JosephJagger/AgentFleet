import html
import httpx
from django.conf import settings


class DeliveryError(Exception):
    pass


def send_code(email, code, challenge_id, locale):
    if not settings.RESEND_API_KEY or not settings.RESEND_FROM_EMAIL:
        raise DeliveryError()
    intro = "你的 AgentFleets 登录验证码" if locale == "zh" else "Your AgentFleets sign-in code"
    footer = ("验证码 10 分钟内有效。如非本人操作，请忽略此邮件。" if locale == "zh"
              else "This code expires in 10 minutes. If you did not request it, ignore this email.")
    try:
        response = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}",
                     "Idempotency-Key": f"agentfleets-login/{challenge_id}"},
            json={"from": f"{settings.RESEND_FROM_NAME} <{settings.RESEND_FROM_EMAIL}>",
                  "to": [email], "subject": intro,
                  "text": f"{intro}\n\n{code}\n\n{footer}",
                  "html": f'<h2>AgentFleets</h2><p>{html.escape(intro)}</p>'
                          f'<p style="font-size:32px;letter-spacing:6px">{code}</p><p>{html.escape(footer)}</p>'},
            timeout=10, follow_redirects=False,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not data["id"]:
            raise DeliveryError()
    except (httpx.HTTPError, ValueError):
        # Do not expose provider responses, API keys, addresses or codes in errors.
        raise DeliveryError() from None
