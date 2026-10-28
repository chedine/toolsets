#!/usr/bin/env python3
"""Rebuild test-vault/ with a fixed set of notes that exercise search, ask and the graph.

    python3 scripts/make_test_vault.py            # wipes and regenerates ./test-vault
"""
import os
import shutil
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vault import render_file, slugify, tags  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-vault")

# (days ago, text). Clusters: AI/energy/water, coffee/sleep/health, books/trees, travel, chips/geopolitics.
NOTES = [
    (0, "A [[data center]] can consume upto 100 to 500 thousand gallons of [[water]] a day. #stat"),
    (1, "[[Electricity]] demand from [[data center]]s could double by 2030, per the [[IEA]]. #stat #energy"),
    (2, "[[Microsoft]] signed a 20-year deal to restart [[Three Mile Island]] to power its [[data center]]s. #energy"),
    (3, "Opinion: [[nuclear power]] is the only realistic baseload for [[AI]] growth. Solar + storage won't scale fast enough. #opinion #energy"),
    (4, "Good [[espresso]]:\n- 18g in, 36g out\n- 25–30 seconds\n- [[water]] at 93°C, soft not distilled\n#recipe #coffee"),
    (5, "[[Arizona]] groundwater is being pumped faster than it recharges. Odd place to build [[data center]]s. #water"),
    (6, "A single [[ChatGPT]] query uses roughly 10x the [[electricity]] of a web search. Worth verifying. #stat #verify"),
    (8, "[[Caffeine]] half-life is about 5 hours. No [[espresso]] after 2pm. #health #coffee"),
    (9, "[[Kahneman]]: the remembering self and the experiencing self disagree about what made us happy. #books #psychology"),
    (11, "Book rec from Sam: [[The Overstory]] by [[Richard Powers]]. #books"),
    (12, "[[Trees]] share sugars and warning signals through fungal networks. Central idea of [[The Overstory]]. #books #nature"),
    (15, "[[Lisbon]]: tram 28 is packed with tourists. Take the 12 instead, same views. #travel"),
    (17, "[[Sleep]] debt can't be fully repaid on weekends. [[Caffeine]] just masks it. #health"),
    (20, "[[Taiwan]] makes over 90% of the most advanced chips, almost all at [[TSMC]]. #stat #geopolitics"),
    (22, "[[AI]] training runs are limited by [[electricity]] and grid hookups more than by chips now. #energy"),
    (26, "Idea: a notes app where search is the only interface. No folders, no list. #idea"),
    (27, "[[Google]] reported its [[data center]]s used about 6 billion gallons of [[water]] in a year. #stat #water"),
    (29, "Evaporative cooling is why [[data center]]s drink so much [[water]]; closed-loop cooling trades water for [[electricity]]. #water #energy"),
    (31, "[[Nvidia]] designs the chips but [[TSMC]] fabs them. Single point of failure for [[AI]]. #geopolitics"),
    (33, "[[Small modular reactor]]s keep slipping. First commercial units maybe 2030. Skeptical. #opinion #energy"),
    (35, "[[Lisbon]] → [[Porto]] by train is under 3 hours. Book the Alfa Pendular. #travel"),
    (38, "[[Pastel de nata]] at Manteigaria beats Belém. Fight me. #opinion #travel #food"),
    (40, "[[Matcha]] has [[caffeine]] plus L-theanine, calmer than [[espresso]]. #health #coffee"),
    (43, "[[Sleep]]: same wake time every day matters more than bedtime. #health"),
    (45, "[[Richard Powers]] also wrote [[Bewilderment]]. Shorter, sadder. #books"),
    (48, "[[Kahneman]] and [[Tversky]]: people feel losses about twice as strongly as gains. #books #psychology"),
    (52, "[[Water]] used to grow almonds in [[California]]: about a gallon per almond. #stat #water"),
    (55, "The [[IEA]] says [[AI]] could be a net reducer of emissions if it optimizes grids. Feels optimistic. #opinion"),
    (60, "Remember to renew passport before the [[Japan]] trip. #todo"),
    (64, "[[Kyoto]] in November: maple season, crowded but worth it. #travel"),
    (70, "Untagged thought: entities feel like the right unit of memory, not documents."),
    (75, "Things to try:\n- cold brew with [[Matcha]]\n- [[espresso]] tonic\n- pour-over at 1:16"),
    (90, "[[Fungi]] networks connect [[trees]] across a forest; some call it the wood wide web. #nature"),
    (120, "[[Taiwan]] earthquake in 2024 briefly halted [[TSMC]] fabs. #geopolitics"),
    (200, "Thermodynamics joke: [[entropy]] isn't what it used to be."),
    (400, "[[Lisbon]] tip from last year: the Feira da Ladra flea market is Tuesdays and Saturdays. #travel"),
]

# Files written by hand (no frontmatter), to check the vault accepts them.
HAND = {
    "hand-written.md": "Typed in an editor, no frontmatter. Mentions [[water]] and [[Lisbon]]. #travel\n",
}


def main():
    if os.path.exists(ROOT):
        shutil.rmtree(ROOT)
    os.makedirs(ROOT)
    base = datetime.now().astimezone().replace(hour=9, minute=0, second=0, microsecond=0)
    for i, (days, text) in enumerate(NOTES):
        when = base - timedelta(days=days, minutes=i * 7)
        note_id = when.strftime("%Y%m%d-%H%M%S")
        t = tags(text)
        rel = os.path.join(t[0] if t else "", f"{note_id}-{slugify(text)}.md")
        os.makedirs(os.path.dirname(os.path.join(ROOT, rel)), exist_ok=True)
        with open(os.path.join(ROOT, rel), "w", encoding="utf-8") as f:
            f.write(render_file({"id": note_id, "created": when.isoformat(timespec="seconds")}, text))
    for rel, text in HAND.items():
        with open(os.path.join(ROOT, rel), "w", encoding="utf-8") as f:
            f.write(text)
    print(f"{len(NOTES) + len(HAND)} notes in {ROOT}")


if __name__ == "__main__":
    main()
