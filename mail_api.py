# pyrefly: ignore [missing-import]
import httpx
import logging
import asyncio
from config import MAIL_TM_API_BASE

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Content-Type": "application/json"
}

class MailTmAPI:
    def __init__(self):
        self.default_base_url = MAIL_TM_API_BASE.rstrip("/")
        self.timeout = httpx.Timeout(15.0, connect=10.0)
        self._client = None
        self.active_provider = "mail_tm"  # Mail.tm Primary API

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                headers=HEADERS,
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
                follow_redirects=True
            )
        return self._client

    def get_base_urls(self) -> list:
        """Return priority list of Mail.tm API endpoints."""
        return ["https://api.mail.tm", "https://api.mail.gw"]

    async def get_domains(self, retries: int = 2) -> list:
        """Fetch list of available active domains dynamically from Mail.tm API."""
        client = self._get_client()
        base_urls = self.get_base_urls()
        active_domains = []
        for base_url in base_urls:
            for attempt in range(retries):
                try:
                    res = await client.get(f"{base_url}/domains")
                    if res.status_code == 200:
                        data = res.json()
                        if isinstance(data, list):
                            members = data
                        elif isinstance(data, dict):
                            members = data.get("hydra:member", []) or data.get("member", []) or data.get("domains", [])
                        else:
                            members = []

                        for d in members:
                            if isinstance(d, dict) and d.get("isActive", True):
                                domain_str = d.get("domain")
                                if domain_str and domain_str not in active_domains:
                                    active_domains.append(domain_str)
                            elif isinstance(d, str) and d not in active_domains:
                                active_domains.append(d)

                        if active_domains:
                            break
                    else:
                        logger.warning(f"Fetch domains [{base_url}] status {res.status_code} (attempt {attempt+1}/{retries})")
                except Exception as e:
                    logger.warning(f"Fetch domains [{base_url}] error: {e} (attempt {attempt+1}/{retries})")
                if attempt < retries - 1:
                    await asyncio.sleep(0.5)

        return active_domains

    async def create_account(self, address: str, password: str, retries: int = 2) -> dict:
        """Create a new temporary email account on Mail.tm API."""
        client = self._get_client()
        payload = {"address": address, "password": password}
        base_urls = self.get_base_urls()
        last_exception = None
        for base_url in base_urls:
            for attempt in range(retries):
                try:
                    res = await client.post(f"{base_url}/accounts", json=payload)
                    if res.status_code in (200, 201):
                        return res.json()
                    elif res.status_code == 422:
                        err_json = res.json()
                        violations = err_json.get("violations", [])
                        msg = violations[0].get("message") if violations else (err_json.get("detail") or "Account already exists")
                        raise ValueError(f"EXISTS: {msg}")
                    else:
                        logger.warning(f"Create account [{base_url}] status {res.status_code}: {res.text}")
                except ValueError:
                    raise
                except Exception as e:
                    last_exception = e
                    logger.warning(f"Create account [{base_url}] attempt {attempt+1} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(0.5)
        if last_exception:
            raise last_exception
        raise RuntimeError("Failed to create account on Mail.tm API")

    async def get_token(self, address: str, password: str, retries: int = 2) -> str:
        """Authenticate account credentials and return Bearer JWT Token from Mail.tm API."""
        client = self._get_client()
        payload = {"address": address, "password": password}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            for attempt in range(retries):
                try:
                    res = await client.post(f"{base_url}/token", json=payload)
                    if res.status_code == 200:
                        data = res.json()
                        token = data.get("token", "")
                        if token:
                            return token
                except Exception as e:
                    logger.warning(f"Get token [{base_url}] attempt {attempt+1} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(0.5)
        return ""

    async def get_messages(self, token: str, page: int = 1, retries: int = 2, email: str = "") -> list:
        """Fetch inbox message summary list from Mail.tm API for authenticated token."""
        if not token or token == "1secmail":
            raise Exception("UNAUTHORIZED")

        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            for attempt in range(retries):
                try:
                    res = await client.get(f"{base_url}/messages?page={page}", headers=headers)
                    if res.status_code == 200:
                        data = res.json()
                        if isinstance(data, list):
                            return data
                        elif isinstance(data, dict):
                            return data.get("hydra:member", []) or data.get("member", []) or []
                    elif res.status_code == 401:
                        raise Exception("UNAUTHORIZED")
                except Exception as e:
                    if str(e) == "UNAUTHORIZED":
                        raise
                    logger.warning(f"Get messages [{base_url}] attempt {attempt+1} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(0.5)
        return []

    async def get_message_detail(self, token: str, message_id: str, retries: int = 2, email: str = "") -> dict:
        """Fetch full details of a specific email message from Mail.tm API."""
        if not token or token == "1secmail":
            raise Exception("UNAUTHORIZED")

        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            for attempt in range(retries):
                try:
                    res = await client.get(f"{base_url}/messages/{message_id}", headers=headers)
                    if res.status_code == 200:
                        return res.json()
                    elif res.status_code == 401:
                        raise Exception("UNAUTHORIZED")
                except Exception as e:
                    if str(e) == "UNAUTHORIZED":
                        raise
                    logger.warning(f"Get message detail [{base_url}] attempt {attempt+1} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(0.5)
        return {}

    async def get_account_me(self, token: str) -> dict:
        """Fetch account details (/me) from Mail.tm API using Bearer JWT Token."""
        if not token or token == "1secmail":
            return {}

        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            try:
                res = await client.get(f"{base_url}/me", headers=headers)
                if res.status_code == 200:
                    return res.json()
            except Exception as e:
                logger.warning(f"Get /me [{base_url}] failed: {e}")
        return {}

    async def delete_account(self, token: str, account_id: str) -> bool:
        """Delete an account permanently on Mail.tm API."""
        if not token or token == "1secmail":
            return False

        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            try:
                res = await client.delete(f"{base_url}/accounts/{account_id}", headers=headers)
                if res.status_code in (200, 204):
                    return True
            except Exception as e:
                logger.error(f"Delete account [{base_url}] error: {e}")
        return False

    async def delete_message(self, token: str, message_id: str) -> bool:
        """Delete a single message permanently on Mail.tm API."""
        if not token or token == "1secmail":
            return False

        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        base_urls = self.get_base_urls()
        for base_url in base_urls:
            try:
                res = await client.delete(f"{base_url}/messages/{message_id}", headers=headers)
                if res.status_code in (200, 204):
                    return True
            except Exception as e:
                logger.error(f"Delete message [{base_url}] error: {e}")
        return False

mail_api = MailTmAPI()
