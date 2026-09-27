import re
from bs4 import BeautifulSoup

def clean_html_body(html_content: str) -> str:
    """Convert HTML string to clean readable plain text."""
    if not html_content:
        return ""
    soup = BeautifulSoup(html_content, "html.parser")
    # Remove script and style tags
    for element in soup(["script", "style", "head", "title"]):
        element.extract()
    text = soup.get_text(separator="\n")
    # Clean multiple blank lines
    lines = [line.strip() for line in text.splitlines()]
    non_empty_lines = [line for line in lines if line]
    return "\n".join(non_empty_lines)

def extract_otp_codes(text: str) -> list:
    """Extract 4-8 character OTP verification codes (including FB-123456, G-123456, 123-456) from text."""
    if not text:
        return []
    
    found_codes = []

    # 1. Meta / Google / Microsoft / Instagram style prefixed codes e.g. "FB-123456", "G-987654"
    prefix_matches = re.findall(r"\b(?:FB|G|IG|MS|VERIFY)[-:\s]?([0-9]{5,8})\b", text, re.IGNORECASE)
    for m in prefix_matches:
        if m not in found_codes:
            found_codes.append(m)

    # 2. Hyphenated or spaced codes e.g. "123-456" -> "123456"
    hyphen_matches = re.findall(r"\b([0-9]{3})[- ]([0-9]{3,4})\b", text)
    for m1, m2 in hyphen_matches:
        combined = f"{m1}{m2}"
        if combined not in found_codes:
            found_codes.append(combined)

    # 3. Labeled patterns e.g. "code is 123456" or "security code: 987654"
    labeled_patterns = [
        r"(?:code|otp|pin|verification|passcode|confirm|security)\s*(?:is|:|=|-)?\s*\b([0-9A-Za-z]{4,8})\b",
        r"\b([0-9]{4,8})\b"
    ]
    
    for pattern in labeled_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for m in matches:
            if isinstance(m, tuple):
                m = m[0]
            clean_m = re.sub(r'[^0-9A-Za-z]', '', str(m)).strip()
            if 4 <= len(clean_m) <= 8 and any(c.isdigit() for c in clean_m):
                if len(clean_m) == 4 and clean_m.startswith(("19", "20")):
                    continue
                if clean_m not in found_codes:
                    found_codes.append(clean_m)
                
    return found_codes[:3]


def extract_urls(text: str) -> list:
    """Extract http/https links from email body."""
    if not text:
        return []
    url_pattern = r'https?://[^\s<>"]+|www\.[^\s<>"]+'
    urls = re.findall(url_pattern, text)
    unique_urls = []
    for u in urls:
        u = u.rstrip('.,;)')
        if u not in unique_urls and not any(ext in u.lower() for ext in ['.png', '.jpg', '.jpeg', '.gif', '.css', '.js']):
            unique_urls.append(u)
    return unique_urls[:5] # return top 5 links


def generate_totp_code(secret: str) -> str:
    """Generate 6-digit TOTP authentication code from a base32 secret key."""
    import base64
    import hmac
    import hashlib
    import struct
    import time
    
    if not secret:
        return "ERROR: Empty Secret"
    
    # Clean whitespace, hyphens, and invalid characters
    clean_secret = re.sub(r'[^A-Za-z2-7]', '', secret.upper())
    if not clean_secret:
        return "ERROR: Invalid Secret"
    
    # Add base32 padding if missing
    missing_padding = len(clean_secret) % 8
    if missing_padding != 0:
        clean_secret += '=' * (8 - missing_padding)
        
    try:
        key = base64.b32decode(clean_secret, casefold=True)
    except Exception:
        return "ERROR: Invalid Secret"
    
    try:
        counter = int(time.time() // 30)
        msg = struct.pack(">Q", counter)
        mac = hmac.new(key, msg, hashlib.sha1).digest()
        offset = mac[-1] & 0x0F
        binary = struct.unpack(">I", mac[offset:offset+4])[0] & 0x7FFFFFFF
        otp = binary % 1000000
        return f"{otp:06d}"
    except Exception as e:
        return f"ERROR: {str(e)}"

