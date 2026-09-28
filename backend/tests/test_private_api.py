import unittest

from fastapi.testclient import TestClient

from backend.server import app


class PrivateApiTests(unittest.TestCase):
    def setUp(self):
        app.state.session_token = "fixture-private-session"
        self.client = TestClient(app)

    def test_only_authenticated_desktop_can_read_or_change_collector(self):
        for method, route in (("get", "/api/status"), ("get", "/api/history"),
                              ("get", "/api/logs"), ("post", "/api/logs/clear"),
                              ("get", "/health")):
            with self.subTest(route=route):
                self.assertEqual(getattr(self.client, method)(route).status_code, 401)
                self.assertEqual(getattr(self.client, method)(route, headers={
                    "Authorization": "Bearer another-session"}).status_code, 401)
        response = self.client.get("/health", headers={
            "Authorization": "Bearer fixture-private-session", "Origin": "https://untrusted.example"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_missing_session_configuration_fails_closed(self):
        app.state.session_token = None
        self.assertEqual(self.client.get("/health", headers={
            "Authorization": "Bearer fixture-private-session"}).status_code, 401)
