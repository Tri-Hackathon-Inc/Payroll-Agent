import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DEBUG = os.getenv('DJANGO_DEBUG', 'false').lower() == 'true'
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', 'local-development-only-change-before-deployment')
ALLOWED_HOSTS = os.getenv('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',')
INSTALLED_APPS = ['registry']
TEMPLATE_CONFIG_DIR = Path(os.getenv('TEMPLATE_CONFIG_DIR', str(BASE_DIR / 'templates')))
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.middleware.common.CommonMiddleware']
WSGI_APPLICATION = 'local_server.studio.wsgi.application'
ASGI_APPLICATION = 'local_server.studio.asgi.application'
# JSON owns the catalog; businesses and configured agents persist independently.
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3',
                         'NAME': os.getenv('DATABASE_PATH', str(BASE_DIR / 'template_catalog.sqlite3')),
                         'OPTIONS': {'timeout': 20}}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
USE_TZ = True
TIME_ZONE = 'UTC'
STATIC_URL = 'static/'
DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
