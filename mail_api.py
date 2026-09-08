import httpx
import logging
from config import MAIL_TM_API_BASE

logger = logging.getLogger(__name__)

class MailTmAPI:
    def __init__(self):
        self.base_url = MAIL_TM_API_BASE
        self.timeout = 15.0

    async def get_domains(self) -> list:
        """Fetch list of available active domains from Mail.tm."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.get(f"{self.base_url}/domains")
            if res.status_code == 200:
                data = res.json()
                members = data.get("hydra:member", [])
                return [d["domain"] for d in members if d.get("isActive", True)]
            else:
                logger.error(f"Failed to fetch domains: {res.status_code} {res.text}")
                return []

    async def create_account(self, address: str, password: str) -> dict:
        """Create a new temporary email account."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            payload = {"address": address, "password": password}
            res = await client.post(
                f"{self.base_url}/accounts",
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            if res.status_code in (200, 201):
                return res.json()
            else:
                logger.error(f"Failed to create account: {res.status_code} {res.text}")
                err_detail = res.json().get("detail", res.text) if res.headers.get("content-type", "").startswith("application/json") else res.text
                raise Exception(f"Account Creation Error: {err_detail}")

    async def get_token(self, address: str, password: str) -> str:
        """Authenticate account credentials and get Bearer JWT Token."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            payload = {"address": address, "password": password}
            res = await client.post(
                f"{self.base_url}/token",
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            if res.status_code == 200:
                data = res.json()
                return data.get("token", "")
            else:
                logger.error(f"Failed to get token for {address}: {res.status_code} {res.text}")
                raise Exception("Invalid email or password. Login failed.")

    async def get_messages(self, token: str, page: int = 1) -> list:
        """Fetch inbox message summary list for the authenticated token."""
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.get(f"{self.base_url}/messages?page={page}", headers=headers)
            if res.status_code == 200:
                data = res.json()
                return data.get("hydra:member", [])
            elif res.status_code == 401:
                raise Exception("UNAUTHORIZED")
            else:
                logger.error(f"Failed to get messages: {res.status_code} {res.text}")
                return []

    async def get_message_detail(self, token: str, message_id: str) -> dict:
        """Fetch full details (including body text/html) of a specific email message."""
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.get(f"{self.base_url}/messages/{message_id}", headers=headers)
            if res.status_code == 200:
                return res.json()
            elif res.status_code == 401:
                raise Exception("UNAUTHORIZED")
            else:
                logger.error(f"Failed to fetch message {message_id}: {res.status_code}")
                return {}

    async def delete_account(self, token: str, account_id: str) -> bool:
        """Delete an account permanently on Mail.tm."""
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.delete(f"{self.base_url}/accounts/{account_id}", headers=headers)
            return res.status_code in (200, 204)

    async def delete_message(self, token: str, message_id: str) -> bool:
        """Delete a single message permanently."""
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.delete(f"{self.base_url}/messages/{message_id}", headers=headers)
            return res.status_code in (200, 204)

mail_api = MailTmAPI()
