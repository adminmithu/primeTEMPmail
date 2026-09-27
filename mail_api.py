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
        self.base_url = MAIL_TM_API_BASE.rstrip("/")
        self.timeout = httpx.Timeout(15.0, connect=10.0)
        self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                headers=HEADERS,
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
                follow_redirects=True
            )
        return self._client

    async def get_domains(self, retries: int = 3) -> list:
        """Fetch list of available active domains from Mail.tm with retries."""
        client = self._get_client()
        for attempt in range(retries):
            try:
                res = await client.get(f"{self.base_url}/domains")
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list):
                        members = data
                    elif isinstance(data, dict):
                        members = data.get("hydra:member", []) or data.get("member", []) or data.get("domains", [])
                    else:
                        members = []

                    active_domains = []
                    for d in members:
                        if isinstance(d, dict) and d.get("isActive", True):
                            domain_str = d.get("domain")
                            if domain_str:
                                active_domains.append(domain_str)
                        elif isinstance(d, str):
                            active_domains.append(d)

                    if active_domains:
                        return active_domains
                else:
                    logger.warning(f"Fetch domains status {res.status_code} (attempt {attempt+1}/{retries})")
            except Exception as e:
                logger.warning(f"Fetch domains error: {e} (attempt {attempt+1}/{retries})")
            if attempt < retries - 1:
                await asyncio.sleep(0.5)
        return []

    async def create_account(self, address: str, password: str, retries: int = 2) -> dict:
        """Create a new temporary email account."""
        client = self._get_client()
        payload = {"address": address, "password": password}
        for attempt in range(retries):
            try:
                res = await client.post(f"{self.base_url}/accounts", json=payload)
                if res.status_code in (200, 201):
                    return res.json()
                elif res.status_code == 422:
                    err_json = res.json()
                    violations = err_json.get("violations", [])
                    msg = violations[0].get("message") if violations else (err_json.get("detail") or "Account already exists")
                    raise ValueError(f"EXISTS: {msg}")
                else:
                    logger.warning(f"Create account status {res.status_code}: {res.text}")
            except ValueError:
                raise
            except Exception as e:
                logger.warning(f"Create account attempt {attempt+1} failed: {e}")
            if attempt < retries - 1:
                await asyncio.sleep(0.5)
        raise Exception(f"Failed to create account for {address}")

    async def get_token(self, address: str, password: str, retries: int = 3) -> str:
        """Authenticate account credentials and get Bearer JWT Token."""
        client = self._get_client()
        payload = {"address": address, "password": password}
        for attempt in range(retries):
            try:
                res = await client.post(f"{self.base_url}/token", json=payload)
                if res.status_code == 200:
                    data = res.json()
                    return data.get("token", "")
            except Exception as e:
                logger.warning(f"Get token attempt {attempt+1} failed: {e}")
            if attempt < retries - 1:
                await asyncio.sleep(0.5)
        logger.error(f"Failed to get token for {address}")
        raise Exception("Invalid email or password. Login failed.")

    async def get_messages(self, token: str, page: int = 1, retries: int = 2) -> list:
        """Fetch inbox message summary list for the authenticated token."""
        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        for attempt in range(retries):
            try:
                res = await client.get(f"{self.base_url}/messages?page={page}", headers=headers)
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
                logger.warning(f"Get messages attempt {attempt+1} failed: {e}")
            if attempt < retries - 1:
                await asyncio.sleep(0.5)
        return []

    async def get_message_detail(self, token: str, message_id: str, retries: int = 2) -> dict:
        """Fetch full details (including body text/html) of a specific email message."""
        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        for attempt in range(retries):
            try:
                res = await client.get(f"{self.base_url}/messages/{message_id}", headers=headers)
                if res.status_code == 200:
                    return res.json()
                elif res.status_code == 401:
                    raise Exception("UNAUTHORIZED")
            except Exception as e:
                if str(e) == "UNAUTHORIZED":
                    raise
                logger.warning(f"Get message detail attempt {attempt+1} failed: {e}")
            if attempt < retries - 1:
                await asyncio.sleep(0.5)
        return {}

    async def delete_account(self, token: str, account_id: str) -> bool:
        """Delete an account permanently on Mail.tm."""
        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        try:
            res = await client.delete(f"{self.base_url}/accounts/{account_id}", headers=headers)
            return res.status_code in (200, 204)
        except Exception as e:
            logger.error(f"Delete account error: {e}")
            return False

    async def delete_message(self, token: str, message_id: str) -> bool:
        """Delete a single message permanently."""
        client = self._get_client()
        headers = {"Authorization": f"Bearer {token}"}
        try:
            res = await client.delete(f"{self.base_url}/messages/{message_id}", headers=headers)
            return res.status_code in (200, 204)
        except Exception as e:
            logger.error(f"Delete message error: {e}")
            return False

mail_api = MailTmAPI()

