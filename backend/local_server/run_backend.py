"""Run gRPC and GraphQL together; stop both if either process exits."""
import os
import signal
import subprocess
import sys
import time


def main():
    processes = []
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        for process in processes:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for command in (['migrate', '--noinput'], ['sync_templates']):
            process = subprocess.Popen([sys.executable, 'manage.py', *command])
            processes.append(process)
            status = process.wait()
            if stopping:
                return 0
            if status:
                return status
        processes.append(subprocess.Popen([
            sys.executable, 'manage.py', 'rungrpc', '--address',
            os.getenv('GRPC_BIND_ADDRESS', '0.0.0.0:50051'), '--insecure-for-testing',
        ]))
        processes.append(subprocess.Popen(['node', 'local_server/apollo.js']))
        while not stopping:
            for process in processes[-2:]:
                status = process.poll()
                if status is not None:
                    return status or 1
            time.sleep(0.2)
        return 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        deadline = time.monotonic() + 8
        for process in processes:
            try:
                process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    sys.exit(main())
