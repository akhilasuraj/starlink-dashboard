"""The boundary between firmware-dependent Starlink calls and the collector."""

import socket

try:
    from backend.official_device import ROUTER_TARGET, get_diagnostics
except ModuleNotFoundError:
    from official_device import ROUTER_TARGET, get_diagnostics


class DishUnreachable(Exception):
    """The local dish endpoint cannot be contacted from this computer."""


class TelemetryError(Exception):
    """The endpoint answered, but a usable status could not be collected."""


class StarlinkTelemetry:
    """Read-only local status through the maintained community gRPC client."""

    def __init__(self, target="192.168.100.1:9200", router_target=ROUTER_TARGET):
        self.target = target
        self.router_target = router_target
        self._context = None

    def read_status(self):
        try:
            import starlink_grpc

            if self._context is None:
                self._context = starlink_grpc.ChannelContext(self.target)
            status, obstruction, alerts = starlink_grpc.status_data(
                context=self._context
            )
            if not isinstance(status, dict):
                raise TelemetryError("Unexpected status response")
            valid_s = obstruction.get("valid_s") if isinstance(obstruction, dict) else None
            fraction = status.get("fraction_obstructed")
            current = status.get("currently_obstructed")
            # The pinned client reads protobuf defaults even when obstruction_stats
            # is absent. A nondefault value proves the message carried evidence;
            # valid_s is used only as presence evidence, not as a time estimate.
            obstruction_reported = current is True or any(
                isinstance(value, (int, float)) and not isinstance(value, bool) and
                0 < value < float("inf") for value in (valid_s, fraction)
            )
            if not obstruction_reported:
                status = {**status}
                if fraction == 0:
                    status["fraction_obstructed"] = None
                if current is False:
                    status["currently_obstructed"] = None
            observed_alerts = {key: value for key, value in alerts.items()
                               if key.startswith("alert_") and isinstance(value, bool)} if isinstance(alerts, dict) else {}
            # Pinned status_data can expose all-false defaults even when the
            # underlying status has no alerts message. A true flag is evidence.
            if any(observed_alerts.values()):
                status = {**status, "alert_details": observed_alerts}
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
            general, bulk = starlink_grpc.history_bulk_data(900, context=self._context)
            if not isinstance(general, dict) or not isinstance(bulk, dict):
                raise TelemetryError("Unexpected history response")
            return general, bulk
        except ImportError as error:
            raise TelemetryError("starlink-grpc-core is not installed") from error
        except Exception as error:
            self.close()
            raise TelemetryError(str(error)) from error

    def read_obstruction_map(self):
        """Read directional SNR samples; these are not a camera image."""
        try:
            import starlink_grpc
            # This optional RPC may take longer than a status poll. Give it a
            # separate channel so failure cannot close the live-status channel.
            context = starlink_grpc.ChannelContext(self.target)
            try:
                return starlink_grpc.obstruction_map(context=context)
            finally:
                context.close()
        except ImportError as error:
            raise TelemetryError("starlink-grpc-core is not installed") from error
        except Exception as error:
            raise TelemetryError(str(error)) from error

    def read_dish_diagnostics(self):
        return get_diagnostics(self.target, "dish")

    def read_router_diagnostics(self):
        return get_diagnostics(self.router_target, "router")

    def close(self):
        if self._context is not None:
            self._context.close()
            self._context = None
