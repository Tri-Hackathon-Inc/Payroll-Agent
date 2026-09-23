import json

from django.core.management.base import BaseCommand, CommandError

from registry.catalog import CatalogError, load_catalog


class Command(BaseCommand):
    help = "Validate local template, model, and service configuration files."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dump", action="store_true", help="Print the validated catalog as JSON."
        )

    def handle(self, *args, **options):
        try:
            catalog = load_catalog()
        except CatalogError as error:
            raise CommandError(str(error)) from error
        if options["dump"]:
            self.stdout.write(json.dumps(catalog, indent=2))
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Validated {len(catalog['templates'])} templates, "
                    f"{len(catalog['model_configs'])} model configs, and {len(catalog['services'])} services."
                )
            )
