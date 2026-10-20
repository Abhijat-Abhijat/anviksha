"""All runtime settings, read once from environment variables."""
import os

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")  # fallback when a tier model is unavailable
# "Auto" mode: each agent declares a tier; each tier gets the model best suited to it.
MODEL_TIERS = {
    "fast": os.getenv("ANVIKSHA_MODEL_FAST", "openai/gpt-oss-20b"),             # many short, simple calls
    "reasoning": os.getenv("ANVIKSHA_MODEL_REASONING", "openai/gpt-oss-120b"),  # judgement and synthesis
    "writing": os.getenv("ANVIKSHA_MODEL_WRITING", "openai/gpt-oss-120b"),      # long-form output
}
ACCESS_KEY = os.getenv("ANVIKSHA_ACCESS_KEY", "")
N_PAPERS = int(os.getenv("ANVIKSHA_PAPERS", "5"))
MAX_ATTEMPTS = int(os.getenv("ANVIKSHA_MAX_ATTEMPTS", "3"))   # hypothesis cycles before moving on
THRESHOLD = float(os.getenv("ANVIKSHA_THRESHOLD", "0.8"))      # confidence needed to approve
