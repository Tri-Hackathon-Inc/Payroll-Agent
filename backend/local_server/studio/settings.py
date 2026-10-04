import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DEBUG = os.getenv('DJANGO_DEBUG', 'false').lower() == 'true'
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', 'local-development-only-change-before-deployment')
ALLOWED_HOSTS = os.getenv('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',')
INSTALLED_APPS = ['storage.apps.StorageConfig']
TEMPLATE_CONFIG_DIR = Path(os.getenv('TEMPLATE_CONFIG_DIR', str(BASE_DIR / 'templates')))
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.middleware.common.CommonMiddleware']
WSGI_APPLICATION = 'local_server.studio.wsgi.application'
ASGI_APPLICATION = 'local_server.studio.asgi.application'
# JSON owns the catalog; domains and configured agents persist independently.
if os.getenv('MYSQL_HOST'):
    DATABASES = {'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('MYSQL_DATABASE', 'payroll'),
        'USER': os.getenv('MYSQL_USER', 'payroll'),
        'PASSWORD': os.environ['MYSQL_PASSWORD'],
        'HOST': os.environ['MYSQL_HOST'],
        'PORT': os.getenv('MYSQL_PORT', '3306'),
        'OPTIONS': {'connect_timeout': 5, 'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"},
    }}
else:
    # SQLite remains available for standalone development and isolated tests.
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3',
                             'NAME': os.getenv('DATABASE_PATH', str(BASE_DIR / 'template_catalog.sqlite3')),
                             'OPTIONS': {'timeout': 20}}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
USE_TZ = True
TIME_ZONE = 'UTC'
STATIC_URL = 'static/'
DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
