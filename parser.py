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
    """Extract 4-8 character OTP verification codes containing digits from text."""
    if not text:
        return []
    
    # Priority pattern for labeled codes e.g. "code is 123456" or "OTP: 98765"
    labeled_patterns = [
        r"(?:code|otp|pin|verification|passcode)\s*(?:is|:|=|-)?\s*\b([0-9A-Za-z]*[0-9]+[0-9A-Za-z]*)\b",
        r"\b([0-9]{4,8})\b"
    ]
    
    found_codes = []
    
    for pattern in labeled_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for m in matches:
            if isinstance(m, tuple):
                m = m[0]
            m = str(m).strip()
            # Must be 4 to 8 chars long and contain digits
            if 4 <= len(m) <= 8 and any(c.isdigit() for c in m):
                # Ignore pure year digits like 2026, 2025
                if len(m) == 4 and m.startswith(("19", "20")):
                    continue
                if m not in found_codes:
                    found_codes.append(m)
                
    return found_codes[:3] # return top 3 potential codes


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
