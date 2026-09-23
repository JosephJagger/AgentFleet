from django.urls import path
from accounts import views

urlpatterns = [
    path("healthz", views.health),
    path("internal/auth/request-code", views.request_code),
    path("internal/auth/verify-code", views.verify_code),
]
