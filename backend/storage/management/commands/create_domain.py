from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from storage.models import Domain


class Command(BaseCommand):
    help = "Provision a domain without changing an existing domain category."

    def add_arguments(self, parser):
        parser.add_argument(
            "name", help="Stable domain slug, for example payroll-services."
        )
        parser.add_argument("--label", required=True)
        parser.add_argument("--domain", required=True)

    def handle(self, *args, **options):
        candidate = Domain(
            name=options["name"], label=options["label"], domain=options["domain"]
        )
        try:
            candidate.full_clean(validate_unique=False)
        except ValidationError as error:
            raise CommandError("; ".join(error.messages)) from error
        domain, created = Domain.objects.get_or_create(
            name=candidate.name,
            defaults={"label": candidate.label, "domain": candidate.domain},
        )
        if domain.domain != candidate.domain:
            raise CommandError(
                f"Domain {domain.name!r} already belongs to domain {domain.domain!r}."
            )
        self.stdout.write(
            self.style.SUCCESS(
                f'{"Created" if created else "Existing"} domain: {domain.name} ({domain.label}, {domain.domain})'
            )
        )
