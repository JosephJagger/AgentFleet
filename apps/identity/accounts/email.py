import html
import httpx
from django.conf import settings


class DeliveryError(Exception):
    pass


MESSAGES = {
    "en": ("Your AgentFleets sign-in code", "This code expires in 10 minutes. If you didn’t request it, you can ignore this email."),
    "zh": ("你的 AgentFleets 登录验证码", "验证码 10 分钟内有效。如非本人操作，请忽略此邮件。"),
    "zh-TW": ("你的 AgentFleets 登入驗證碼", "驗證碼將於 10 分鐘後失效。如果你未要求登入，請忽略這封郵件。"),
    "ja": ("AgentFleets のログイン確認コード", "このコードは10分間有効です。ログインに心当たりがない場合は、このメールを破棄してください。"),
    "ko": ("AgentFleets 로그인 인증 코드", "인증 코드는 10분 동안 유효합니다. 로그인을 요청하지 않았다면 이 메일을 무시하셔도 됩니다."),
    "de": ("Ihr Anmeldecode für AgentFleets", "Dieser Code ist 10 Minuten gültig. Falls Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren."),
    "fr": ("Votre code de connexion AgentFleets", "Ce code est valable 10 minutes. Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail."),
    "es": ("Tu código de acceso a AgentFleets", "Este código caduca en 10 minutos. Si no lo has solicitado, puedes ignorar este correo."),
    "it": ("Il tuo codice di accesso ad AgentFleets", "Il codice è valido per 10 minuti. Se non l’hai richiesto, puoi ignorare questa email."),
    "nl": ("Je inlogcode voor AgentFleets", "Deze code is 10 minuten geldig. Heb je de code niet aangevraagd? Dan kun je deze e-mail negeren."),
    "pt-BR": ("Seu código de acesso ao AgentFleets", "Este código expira em 10 minutos. Se você não o solicitou, pode ignorar este e-mail."),
}


def send_code(email, code, challenge_id, locale):
    if not settings.RESEND_API_KEY or not settings.RESEND_FROM_EMAIL:
        raise DeliveryError()
    intro, footer = MESSAGES.get("zh" if locale == "zh-CN" else locale, MESSAGES["en"])
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
