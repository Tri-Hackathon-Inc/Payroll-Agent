from django.core.management.base import BaseCommand, CommandError
from template.catalog import CatalogError
from template.services import sync_templates


class Command(BaseCommand):
    help = (
        "Validate JSON files and atomically synchronize the template catalog database."
    )

    def handle(self, *args, **options):
        try:
            counts = sync_templates()
        except CatalogError as error:
            raise CommandError(str(error)) from error
        self.stdout.write(self.style.SUCCESS(f"Synchronized catalog: {counts}"))
