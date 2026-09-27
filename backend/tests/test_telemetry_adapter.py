import unittest
from unittest.mock import Mock, patch

import starlink_grpc

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


if __name__ == "__main__":
    unittest.main()
