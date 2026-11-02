"""Settings and prompts: shipped defaults, overridden per data folder.

<data>/config.json is deep-merged over config.default.json, and <data>/prompts/<name>.md replaces
prompts/<name>.md. The Settings page writes both, so edits survive upgrades of the app itself.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPTS = os.path.join(HERE, "prompts")
PROMPT_NAMES = ("outline", "chapter", "more_questions", "rewrite_lesson", "grade", "tutor", "question_schema")
NAME_RE = re.compile(r"^[a-z_]{1,40}$")


def merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


class Config:
    def __init__(self, data_dir):
        self.data = data_dir
        self.user_file = os.path.join(data_dir, "config.json")
        self.user_prompts = os.path.join(data_dir, "prompts")
        self.reload()

    def reload(self):
        with open(os.path.join(HERE, "config.default.json"), encoding="utf-8") as f:
            self.defaults = json.load(f)
        self.user = {}
        if os.path.exists(self.user_file):
            with open(self.user_file, encoding="utf-8") as f:
                self.user = json.load(f)
        self.values = merge(self.defaults, self.user)

    def __getitem__(self, key):
        return self.values[key]

    def get(self, key, default=None):
        return self.values.get(key, default)

    def update(self, over):
        """Merge `over` into the user's override file (not the shipped defaults)."""
        self.user = merge(self.user, over)
        os.makedirs(self.data, exist_ok=True)
        tmp = self.user_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.user, f, indent=2)
        os.replace(tmp, self.user_file)
        self.values = merge(self.defaults, self.user)

    # ---- prompts -----------------------------------------------------------

    def prompt_path(self, name, user):
        if not NAME_RE.match(name) or name not in PROMPT_NAMES:
            raise KeyError(name)
        return os.path.join(self.user_prompts if user else PROMPTS, f"{name}.md")

    def prompt(self, name):
        p = self.prompt_path(name, True)
        if not os.path.exists(p):
            p = self.prompt_path(name, False)
        with open(p, encoding="utf-8") as f:
            return f.read()

    def prompts(self):
        return [{"name": n, "text": self.prompt(n), "overridden": os.path.exists(self.prompt_path(n, True))}
                for n in PROMPT_NAMES]

    def set_prompt(self, name, text):
        p = self.prompt_path(name, True)
        os.makedirs(self.user_prompts, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)

    def reset_prompt(self, name):
        p = self.prompt_path(name, True)
        if os.path.exists(p):
            os.remove(p)


def fill(template, **values):
    """Replace {{name}} placeholders; unknown names are left as they are."""
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), template)
