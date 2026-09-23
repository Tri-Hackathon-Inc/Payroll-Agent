from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from registry.models import Business


class Command(BaseCommand):
    help = "Provision a business without changing an existing business domain."

    def add_arguments(self, parser):
        parser.add_argument(
            "name", help="Stable business slug, for example payroll-services."
        )
        parser.add_argument("--label", required=True)
        parser.add_argument("--domain", required=True)

    def handle(self, *args, **options):
        candidate = Business(
            name=options["name"], label=options["label"], domain=options["domain"]
        )
        try:
            candidate.full_clean(validate_unique=False)
        except ValidationError as error:
            raise CommandError("; ".join(error.messages)) from error
        business, created = Business.objects.get_or_create(
            name=candidate.name,
            defaults={"label": candidate.label, "domain": candidate.domain},
        )
        if business.domain != candidate.domain:
            raise CommandError(
                f"Business {business.name!r} already belongs to domain {business.domain!r}."
            )
        self.stdout.write(
            self.style.SUCCESS(
                f'{"Created" if created else "Existing"} business: {business.name} ({business.label}, {business.domain})'
            )
        )
