"""The boundary between firmware-dependent Starlink calls and the collector."""

import socket


class DishUnreachable(Exception):
    """The local dish endpoint cannot be contacted from this computer."""


class TelemetryError(Exception):
    """The endpoint answered, but a usable status could not be collected."""


class StarlinkTelemetry:
    """Read-only local status through the maintained community gRPC client."""

    def __init__(self, target="192.168.100.1:9200"):
        self.target = target
        self._context = None

    def read_status(self):
        try:
            import starlink_grpc

            if self._context is None:
                self._context = starlink_grpc.ChannelContext(self.target)
            status, _obstruction, _alerts = starlink_grpc.status_data(
                context=self._context
            )
            if not isinstance(status, dict):
                raise TelemetryError("Unexpected status response")
            return status
        except ImportError as error:
            raise TelemetryError("starlink-grpc-core is not installed") from error
        except TelemetryError:
            raise
        except Exception as error:
            # A failed RPC alone cannot tell us whether the route or protocol
            # failed. Probe the local endpoint only after an RPC failure.
            host, port = self.target.rsplit(":", 1)
            try:
                with socket.create_connection((host, int(port)), timeout=2):
                    pass
            except OSError as route_error:
                self.close()
                raise DishUnreachable(str(route_error)) from error
            self.close()
            raise TelemetryError(str(error)) from error

    def read_history(self):
        """Return the pinned core package's general and bulk history dictionaries."""
        try:
            import starlink_grpc

            if self._context is None:
                self._context = starlink_grpc.ChannelContext(self.target)
            general, bulk = starlink_grpc.history_bulk_data(-1, context=self._context)
            if not isinstance(general, dict) or not isinstance(bulk, dict):
                raise TelemetryError("Unexpected history response")
            return general, bulk
        except ImportError as error:
            raise TelemetryError("starlink-grpc-core is not installed") from error
        except Exception as error:
            self.close()
            raise TelemetryError(str(error)) from error

    def close(self):
        if self._context is not None:
            self._context.close()
            self._context = None
