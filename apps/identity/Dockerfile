FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY apps/identity/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home identity && mkdir /data && chown identity:identity /data
COPY --chown=identity:identity apps/identity/ .
USER identity
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn identity.wsgi:application --bind 0.0.0.0:8000 --workers 2 --timeout 30 --worker-tmp-dir /tmp"]
