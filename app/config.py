"""All runtime settings, read once from environment variables."""
import os

GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
ACCESS_KEY = os.getenv("ANVIKSHA_ACCESS_KEY", "")
N_PAPERS = int(os.getenv("ANVIKSHA_PAPERS", "5"))
MAX_ATTEMPTS = int(os.getenv("ANVIKSHA_MAX_ATTEMPTS", "3"))   # hypothesis cycles before moving on
THRESHOLD = float(os.getenv("ANVIKSHA_THRESHOLD", "0.8"))      # confidence needed to approve
