import unittest
from unittest.mock import Mock, patch

import starlink_grpc

from backend.official_device import RPC_PATH, message_types
from backend.telemetry import StarlinkTelemetry


class TelemetryAdapterTests(unittest.TestCase):
    def test_pinned_core_status_data_three_groups(self):
        contexts = []

        class FixtureContext:
            def __init__(self, target):
                self.target = target
                self.closed = False
                contexts.append(self)

            def close(self):
                self.closed = True

        reported = {"state": "CONNECTED", "downlink_throughput_bps": 0}
        with patch.object(starlink_grpc, "ChannelContext", FixtureContext), patch.object(
            starlink_grpc, "status_data", return_value=(reported, {}, {})
        ) as read:
            telemetry = StarlinkTelemetry()
            self.assertEqual(telemetry.read_status(), reported)
            self.assertEqual(contexts[0].target, "192.168.100.1:9200")
            read.assert_called_once_with(context=contexts[0])
            telemetry.close()
            self.assertTrue(contexts[0].closed)

    def test_obstruction_defaults_without_presence_evidence_are_not_observations(self):
        with patch.object(starlink_grpc, "ChannelContext"), patch.object(
            starlink_grpc, "status_data",
            return_value=({"state": "CONNECTED", "fraction_obstructed": 0.0,
                           "currently_obstructed": False}, {"valid_s": 0.0}, {}),
        ):
            reading = StarlinkTelemetry().read_status()
        self.assertIsNone(reading["fraction_obstructed"])
        self.assertIsNone(reading["currently_obstructed"])

    def test_observed_zero_obstruction_survives_with_valid_time_evidence(self):
        with patch.object(starlink_grpc, "ChannelContext"), patch.object(
            starlink_grpc, "status_data",
            return_value=({"state": "CONNECTED", "fraction_obstructed": 0.0,
                           "currently_obstructed": False}, {"valid_s": 3600.0}, {}),
        ):
            reading = StarlinkTelemetry().read_status()
        self.assertEqual(reading["fraction_obstructed"], 0.0)
        self.assertIs(reading["currently_obstructed"], False)

    def test_positive_or_active_obstruction_is_evidence_even_without_valid_time(self):
        for fraction, current in [(0.1, False), (0.0, True)]:
            with self.subTest(fraction=fraction, current=current), patch.object(
                starlink_grpc, "ChannelContext"
            ), patch.object(starlink_grpc, "status_data", return_value=(
                {"state": "CONNECTED", "fraction_obstructed": fraction,
                 "currently_obstructed": current}, {}, {}
            )):
                reading = StarlinkTelemetry().read_status()
                self.assertEqual(reading["fraction_obstructed"], fraction)
                self.assertIs(reading["currently_obstructed"], current)

    def test_pinned_core_bulk_history_contract(self):
        context = Mock()
        general = {"samples": 2, "end_counter": 22}
        bulk = {"downlink_throughput_bps": [0, 1_000_000]}
        with patch.object(starlink_grpc, "ChannelContext", return_value=context), patch.object(
            starlink_grpc, "history_bulk_data", return_value=(general, bulk)
        ) as read:
            telemetry = StarlinkTelemetry()
            self.assertEqual(telemetry.read_history(), (general, bulk))
            read.assert_called_once_with(900, context=context)
            telemetry.close()
            context.close.assert_called_once()

    def test_pinned_core_obstruction_map_reads_directional_snr_rows(self):
        context = Mock()
        rows = ((0.0, 0.5, -1.0), (1.0, 0.75, 0.25))
        with patch.object(starlink_grpc, "ChannelContext", return_value=context), patch.object(
            starlink_grpc, "obstruction_map", return_value=rows
        ) as read:
            telemetry = StarlinkTelemetry()
            self.assertEqual(telemetry.read_obstruction_map(), rows)
            read.assert_called_once_with(context=context)
            context.close.assert_called_once()

    def test_named_alerts_survive_the_pinned_status_adapter(self):
        reported = {"state": "CONNECTED", "alerts": 0}
        with patch.object(starlink_grpc, "ChannelContext"), patch.object(
            starlink_grpc, "status_data",
            return_value=(reported, {}, {"alert_motors_stuck": True, "alert_obstructed": False}),
        ):
            telemetry = StarlinkTelemetry()
            status = telemetry.read_status()
            self.assertEqual(status["alert_details"], {
                "alert_motors_stuck": True, "alert_obstructed": False,
            })

    def test_all_false_community_alert_defaults_do_not_claim_observation(self):
        with patch.object(starlink_grpc, "ChannelContext"), patch.object(
            starlink_grpc, "status_data",
            return_value=({"state": "CONNECTED", "alerts": 0}, {},
                          {"alert_motors_stuck": False, "alert_obstructed": False}),
        ):
            self.assertNotIn("alert_details", StarlinkTelemetry().read_status())

    def test_official_diagnostics_uses_published_handle_request_and_targets(self):
        request_type, response_type = message_types()
        calls = []

        class Channel:
            def __init__(self, target):
                self.target = target

            def unary_unary(self, path, request_serializer, response_deserializer):
                self.assert_path = path

                def call(request, timeout):
                    decoded = request_type.FromString(request_serializer(request))
                    self.request_variant = decoded.WhichOneof("request")
                    self.timeout = timeout
                    result = response_type()
                    if self.target.endswith(":9000"):
                        result.wifi_get_diagnostics.id = "Router-reported"
                        result.wifi_get_diagnostics.hardware_version = "router-rev"
                    else:
                        result.dish_get_diagnostics.id = "ut-reported"
                        result.dish_get_diagnostics.software_version = "dish-fw"
                        result.dish_get_diagnostics.alerts.motors_stuck = True
                    return response_deserializer(result.SerializeToString())

                return call

            def close(self):
                calls.append((self.target, self.assert_path, self.request_variant, self.timeout))

        with patch("backend.official_device.grpc.insecure_channel", side_effect=Channel):
            telemetry = StarlinkTelemetry()
            dish = telemetry.read_dish_diagnostics()
            router = telemetry.read_router_diagnostics()
        self.assertEqual(dish["id"], "ut-reported")
        self.assertEqual(dish["software_version"], "dish-fw")
        self.assertTrue(dish["alerts"]["motors_stuck"])
        self.assertEqual(router["id"], "Router-reported")
        self.assertEqual(router["hardware_version"], "router-rev")
        self.assertEqual(calls, [
            ("192.168.100.1:9200", RPC_PATH, "get_diagnostics", 2.5),
            ("192.168.1.1:9000", RPC_PATH, "get_diagnostics", 2.5),
        ])


if __name__ == "__main__":
    unittest.main()
