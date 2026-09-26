"""`pin.require_loopback_url`. Issue #8 (2026-09-26 fix-round finding).

Before this fix round, the live-leg guard (`test_honcho_roundtrip.TestLiveRoundTrip`)
only rejected a URL containing the substring `"white.local"` -- any OTHER
remote, such as a cloud Honcho or a teammate's machine, was accepted and
would have received real writes. These tests exercise the loopback-only
guard directly, without needing HONCHO_ROUNDTRIP_LIVE_BASE_URL set or any
container running.
"""

from __future__ import annotations

import unittest

from arra_migrate.honcho_roundtrip.pin import HONCHO_V3_2_0, NotALoopbackTargetError, require_loopback_url


class PinEnvIsValidForPinnedHonchoTests(unittest.TestCase):
    """analysis-8 test #8 / 2026-09-26 fix-round finding: nothing pinned
    `HONCHO_V3_2_0.env`'s two LLM-avoidance settings with a test of its own.
    `pin.py`'s own module comment explains why each matters and what an
    earlier, wrong version of this pin got wrong -- these tests are that
    comment, enforced: `DERIVER_WORKERS=0` fails Honcho's own `WORKERS:
    Field(..., gt=0)` at `AppSettings()` import time (the api container would
    never boot), and `EMBED_MESSAGES` defaulting back to its ON default would
    make a boot with no embedding credential try to reach an external
    provider on every message create."""

    def test_deriver_is_disabled_the_correct_way(self) -> None:
        self.assertEqual(HONCHO_V3_2_0.env.get("DERIVER_ENABLED"), "false")
        # NOT DERIVER_WORKERS=0 -- see pin.py's own comment on why that
        # specific, earlier wrong value fails the container at boot.
        self.assertNotIn("DERIVER_WORKERS", HONCHO_V3_2_0.env)

    def test_background_embedding_is_disabled(self) -> None:
        self.assertEqual(HONCHO_V3_2_0.env.get("EMBED_MESSAGES"), "false")


class RequireLoopbackUrlTests(unittest.TestCase):
    def test_127_0_0_1_is_accepted(self) -> None:
        require_loopback_url("http://127.0.0.1:8000")  # must not raise

    def test_localhost_is_accepted(self) -> None:
        require_loopback_url("http://localhost:8000")  # must not raise

    def test_ipv6_loopback_is_accepted(self) -> None:
        require_loopback_url("http://[::1]:8000")  # must not raise

    def test_white_local_is_refused(self) -> None:
        # The specific hostname issue #8's 2026-09-20 scope correction named --
        # still refused, but no longer via a bespoke substring check.
        with self.assertRaises(NotALoopbackTargetError):
            require_loopback_url("http://white.local:8000")

    def test_an_unrelated_remote_hostname_is_also_refused(self) -> None:
        # The actual gap a substring check on "white.local" left open: ANY
        # other remote target sailed through unchecked.
        with self.assertRaises(NotALoopbackTargetError):
            require_loopback_url("https://honcho.example.cloud")

    def test_a_public_ip_is_refused(self) -> None:
        with self.assertRaises(NotALoopbackTargetError):
            require_loopback_url("http://8.8.8.8:8000")


if __name__ == "__main__":
    unittest.main()
