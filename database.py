import aiosqlite
import httpx
import logging
import os
from config import DB_PATH, SUPABASE_URL, SUPABASE_KEY

logger = logging.getLogger(__name__)

# Check if Supabase keys are configured
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY and SUPABASE_URL.startswith("http"))

def get_supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

async def init_db():
    """Initialize SQLite database locally AND verify Supabase REST tables if available."""
    # 1. Local SQLite initialization & migration
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                active_email TEXT,
                language TEXT DEFAULT 'bn',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                token TEXT,
                account_id TEXT,
                last_msg_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(telegram_id, email)
            )
        """)
        
        try:
            await db.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'bn'")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN last_msg_id TEXT")
        except Exception:
            pass

        await db.commit()

    # 2. Supabase Cloud Check
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{SUPABASE_URL}/rest/v1/users?select=count", headers=get_supabase_headers())
                if res.status_code in (200, 206):
                    logger.info("Connected to Supabase Cloud Database successfully.")
        except Exception as e:
            logger.warning(f"Supabase connection check skipped: {e}")

    logger.info("Database initialized successfully.")

async def set_user_language(telegram_id: int, lang: str):
    if USE_SUPABASE:
        try:
            payload = {"telegram_id": telegram_id, "language": lang}
            async with httpx.AsyncClient(timeout=5.0) as client:
                headers = get_supabase_headers()
                headers["Prefer"] = "resolution=merge-duplicates"
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=payload, headers=headers)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, language)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET language = excluded.language
        """, (telegram_id, lang))
        await db.commit()

async def get_user_language(telegram_id: int) -> str:
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=language",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0].get("language", "bn")
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT language FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row and row[0] else "bn"

async def save_account(telegram_id: int, email: str, password: str, token: str = "", account_id: str = ""):
    if USE_SUPABASE:
        try:
            acc_payload = {
                "telegram_id": telegram_id,
                "email": email,
                "password": password,
                "token": token,
                "account_id": account_id
            }
            user_payload = {"telegram_id": telegram_id, "active_email": email}
            headers = get_supabase_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SUPABASE_URL}/rest/v1/accounts", json=acc_payload, headers=headers)
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=user_payload, headers=headers)
        except Exception as e:
            logger.warning(f"Supabase save_account error: {e}")

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO accounts (telegram_id, email, password, token, account_id)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id, email) DO UPDATE SET
                password = excluded.password,
                token = excluded.token,
                account_id = excluded.account_id
        """, (telegram_id, email, password, token, account_id))
        
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        
        await db.commit()

async def get_user_accounts(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&order=id.desc",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id, created_at FROM accounts WHERE telegram_id = ? ORDER BY id DESC",
            (telegram_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def get_account(telegram_id: int, email: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, email)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def get_active_account(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                u_res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=active_email",
                    headers=get_supabase_headers()
                )
                if u_res.status_code == 200 and u_res.json():
                    active_email = u_res.json()[0].get("active_email")
                    if active_email:
                        a_res = await client.get(
                            f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{active_email}",
                            headers=get_supabase_headers()
                        )
                        if a_res.status_code == 200 and a_res.json():
                            return a_res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT active_email FROM users WHERE telegram_id = ?",
            (telegram_id,)
        ) as cursor:
            user_row = await cursor.fetchone()
            if not user_row or not user_row["active_email"]:
                return None
            active_email = user_row["active_email"]

        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, active_email)
        ) as cursor:
            acc_row = await cursor.fetchone()
            return dict(acc_row) if acc_row else None

async def set_active_account(telegram_id: int, email: str):
    if USE_SUPABASE:
        try:
            payload = {"telegram_id": telegram_id, "active_email": email}
            headers = get_supabase_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=payload, headers=headers)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        await db.commit()

async def update_account_token(telegram_id: int, email: str, token: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"token": token},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET token = ? WHERE telegram_id = ? AND email = ?",
            (token, telegram_id, email)
        )
        await db.commit()

async def update_last_msg_id(telegram_id: int, email: str, msg_id: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"last_msg_id": msg_id},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET last_msg_id = ? WHERE telegram_id = ? AND email = ?",
            (msg_id, telegram_id, email)
        )
        await db.commit()

async def delete_saved_account(telegram_id: int, email: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, email)
        )
        async with db.execute("SELECT active_email FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            if row and row[0] == email:
                await db.execute("UPDATE users SET active_email = NULL WHERE telegram_id = ?", (telegram_id,))
        await db.commit()

async def delete_all_user_accounts(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}",
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM accounts WHERE telegram_id = ?", (telegram_id,))
        await db.execute("UPDATE users SET active_email = NULL WHERE telegram_id = ?", (telegram_id,))
        await db.commit()

async def get_all_active_accounts():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?select=telegram_id,email,password,token,last_msg_id",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT u.telegram_id, a.email, a.password, a.token, a.last_msg_id
            FROM users u
            JOIN accounts a ON u.telegram_id = a.telegram_id AND u.active_email = a.email
        """) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def get_all_users():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?select=telegram_id",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return [r["telegram_id"] for r in res.json()]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT telegram_id FROM users") as cursor:
            rows = await cursor.fetchall()
            return [r[0] for r in rows]

async def get_admin_stats():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r1 = await client.get(f"{SUPABASE_URL}/rest/v1/users?select=telegram_id", headers=get_supabase_headers())
                r2 = await client.get(f"{SUPABASE_URL}/rest/v1/accounts?select=id", headers=get_supabase_headers())
                u_cnt = len(r1.json()) if r1.status_code == 200 and isinstance(r1.json(), list) else 0
                a_cnt = len(r2.json()) if r2.status_code == 200 and isinstance(r2.json(), list) else 0
                return {"total_users": u_cnt, "total_accounts": a_cnt}
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as c1:
            total_users = (await c1.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM accounts") as c2:
            total_accounts = (await c2.fetchone())[0]
        return {"total_users": total_users, "total_accounts": total_accounts}
