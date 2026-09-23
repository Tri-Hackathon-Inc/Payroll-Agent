from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import grpc
from django.core.management.base import BaseCommand, CommandError
from registry.servicers import TemplateCatalogServicer
from registry.proto.templates_pb2_grpc import add_TemplateCatalogServicer_to_server


class Command(BaseCommand):
    help = 'Serve the read-only template catalog over gRPC.'

    def add_arguments(self, parser):
        parser.add_argument('--address', default='127.0.0.1:50051')
        parser.add_argument('--tls-cert')
        parser.add_argument('--tls-key')
        parser.add_argument('--insecure-for-testing', action='store_true',
                            help='Allow plaintext between containers for isolated local API testing.')

    def handle(self, *args, **options):
        server = grpc.server(ThreadPoolExecutor(max_workers=4))
        add_TemplateCatalogServicer_to_server(TemplateCatalogServicer(), server)
        cert, key, address = options['tls_cert'], options['tls_key'], options['address']
        if bool(cert) != bool(key):
            raise CommandError('Provide both --tls-cert and --tls-key.')
        if cert:
            credentials = grpc.ssl_server_credentials([(Path(key).read_bytes(), Path(cert).read_bytes())])
            port = server.add_secure_port(address, credentials)
        else:
            if (address.rsplit(':', 1)[0] not in ('127.0.0.1', 'localhost', '[::1]')
                    and not options['insecure_for_testing']):
                raise CommandError('Non-loopback listeners require TLS.')
            port = server.add_insecure_port(address)
        if not port:
            raise CommandError(f'Cannot bind {address}.')
        server.start()
        self.stdout.write(f'Template catalog listening on {address}')
        try:
            server.wait_for_termination()
        except KeyboardInterrupt:
            server.stop(5).wait()
