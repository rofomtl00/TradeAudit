"""
license.py — License Key Validation
====================================
Validates license keys against LemonSqueezy API.
Keys are cached locally so the proxy works offline after first validation.

Free tier: core audit logging (TradeAudit class)
Pro tier:  proxy mode, reconciliation alerts, email digests, multi-exchange
"""

import os
import json
import hashlib
import time
import threading
from datetime import datetime, timezone

try:
    import urllib.request
    import urllib.error
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".license_cache.json")

# LemonSqueezy API endpoint for license validation
LEMONSQUEEZY_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate"
LEMONSQUEEZY_ACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/activate"

# Re-validate every 7 days (works offline between checks)
REVALIDATE_INTERVAL = 7 * 24 * 3600

# Feature gates
FREE_FEATURES = {"audit_core", "verify", "digest"}
PRO_FEATURES = {"proxy", "reconcile_alerts", "multi_exchange", "email_digest", "api_logging"}


class License:
    """Manages license validation and feature gating."""

    def __init__(self, key: str = ""):
        self.key = key or os.environ.get("TRADEAUDIT_LICENSE_KEY", "")
        self.valid = False
        self.plan = "free"  # "free" or "pro"
        self.customer_name = ""
        self.customer_email = ""
        self.expires_at = ""
        self.instance_id = ""
        self._cache = {}
        self._load_cache()

    def _load_cache(self):
        """Load cached validation result."""
        if not os.path.exists(CACHE_FILE):
            return
        try:
            with open(CACHE_FILE, "r") as f:
                self._cache = json.load(f)
            # Check if cache is for this key and not expired
            if (self._cache.get("key_hash") == self._key_hash() and
                    self._cache.get("valid") and
                    time.time() - self._cache.get("validated_at", 0) < REVALIDATE_INTERVAL):
                self.valid = True
                self.plan = self._cache.get("plan", "free")
                self.customer_name = self._cache.get("customer_name", "")
                self.customer_email = self._cache.get("customer_email", "")
                self.expires_at = self._cache.get("expires_at", "")
                self.instance_id = self._cache.get("instance_id", "")
        except Exception:
            pass

    def _save_cache(self):
        """Save validation result to disk."""
        try:
            self._cache = {
                "key_hash": self._key_hash(),
                "valid": self.valid,
                "plan": self.plan,
                "customer_name": self.customer_name,
                "customer_email": self.customer_email,
                "expires_at": self.expires_at,
                "instance_id": self.instance_id,
                "validated_at": time.time(),
            }
            with open(CACHE_FILE, "w") as f:
                json.dump(self._cache, f)
        except Exception:
            pass

    def _key_hash(self) -> str:
        """Hash the key so we don't store it in plaintext in cache."""
        return hashlib.sha256(self.key.encode()).hexdigest()[:16] if self.key else ""

    def validate(self) -> dict:
        """Validate license key against LemonSqueezy API.
        Returns {"valid": bool, "plan": str, "message": str}"""
        if not self.key:
            self.plan = "free"
            return {"valid": False, "plan": "free",
                    "message": "No license key. Running in free tier."}

        # Check cache first
        if self.valid and self.plan == "pro":
            cache_age = time.time() - self._cache.get("validated_at", 0)
            if cache_age < REVALIDATE_INTERVAL:
                return {"valid": True, "plan": "pro",
                        "message": f"Pro license active (cached, recheck in {int((REVALIDATE_INTERVAL - cache_age) / 3600)}h)"}

        if not HAS_URLLIB:
            # Offline — trust cache if available
            if self._cache.get("valid"):
                return {"valid": True, "plan": self.plan,
                        "message": "Offline validation from cache"}
            return {"valid": False, "plan": "free",
                    "message": "Cannot validate (no urllib). Running free tier."}

        # Call LemonSqueezy API
        try:
            # First try to activate (generates instance_id for this machine)
            instance_name = _machine_id()
            data = json.dumps({
                "license_key": self.key,
                "instance_name": instance_name,
            }).encode()

            url = LEMONSQUEEZY_ACTIVATE_URL
            if self.instance_id:
                # Already activated — just validate
                url = LEMONSQUEEZY_VALIDATE_URL
                data = json.dumps({
                    "license_key": self.key,
                    "instance_id": self.instance_id,
                }).encode()

            req = urllib.request.Request(url, data=data, method="POST",
                                         headers={"Content-Type": "application/json",
                                                   "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode())

            if result.get("valid") or result.get("activated"):
                self.valid = True
                self.plan = "pro"
                meta = result.get("meta", {})
                self.customer_name = meta.get("customer_name", "")
                self.customer_email = meta.get("customer_email", "")
                instance = result.get("instance", {})
                if instance.get("id"):
                    self.instance_id = instance["id"]
                self._save_cache()
                return {"valid": True, "plan": "pro",
                        "message": f"Pro license active. Welcome{', ' + self.customer_name if self.customer_name else ''}!"}
            else:
                self.valid = False
                self.plan = "free"
                error = result.get("error", "Invalid key")
                return {"valid": False, "plan": "free",
                        "message": f"License invalid: {error}. Running free tier."}

        except urllib.error.HTTPError as e:
            # 404 = invalid key, 422 = already activated (validate instead)
            if e.code == 422 and not self.instance_id:
                # Already activated on another instance — try validate
                return self._validate_only()
            self.plan = "free"
            return {"valid": False, "plan": "free",
                    "message": f"Validation failed (HTTP {e.code}). Running free tier."}
        except Exception as e:
            # Network error — trust cache if available
            if self._cache.get("valid"):
                self.valid = True
                self.plan = self._cache.get("plan", "free")
                return {"valid": True, "plan": self.plan,
                        "message": "Offline — using cached validation"}
            return {"valid": False, "plan": "free",
                    "message": f"Validation failed: {e}. Running free tier."}

    def _validate_only(self) -> dict:
        """Validate without activating."""
        try:
            data = json.dumps({"license_key": self.key}).encode()
            req = urllib.request.Request(LEMONSQUEEZY_VALIDATE_URL, data=data,
                                         method="POST",
                                         headers={"Content-Type": "application/json",
                                                   "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode())
            if result.get("valid"):
                self.valid = True
                self.plan = "pro"
                self._save_cache()
                return {"valid": True, "plan": "pro", "message": "Pro license active."}
        except Exception:
            pass
        return {"valid": False, "plan": "free", "message": "Validation failed. Running free tier."}

    def has_feature(self, feature: str) -> bool:
        """Check if current plan includes a feature."""
        if feature in FREE_FEATURES:
            return True
        if self.plan == "pro" and feature in PRO_FEATURES:
            return True
        return False

    def status(self) -> dict:
        return {
            "plan": self.plan,
            "valid": self.valid,
            "customer": self.customer_name,
            "features": sorted(FREE_FEATURES | (PRO_FEATURES if self.plan == "pro" else set())),
        }


def _machine_id() -> str:
    """Generate a stable machine identifier for license activation."""
    import platform
    raw = f"{platform.node()}-{platform.machine()}-{platform.system()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:12]
